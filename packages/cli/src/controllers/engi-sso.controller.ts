import { Logger } from '@n8n/backend-common';
import type { User } from '@n8n/db';
import { AuthIdentity, AuthIdentityRepository, UserRepository } from '@n8n/db';
import { Get, RestController } from '@n8n/decorators';
import type { Response } from 'express';
import jwt from 'jsonwebtoken';
import { randomString } from 'n8n-workflow';

import { AuthService } from '@/auth/auth.service';
import { AuthError } from '@/errors/response-errors/auth.error';
import { BadRequestError } from '@/errors/response-errors/bad-request.error';
import { EventService } from '@/events/event.service';
import type { AuthlessRequest } from '@/requests';
import { PasswordUtility } from '@/services/password.utility';

const PROVIDER_TYPE = 'engi-sso';

interface EngiTokenPayload {
	user_id: string;
	email: string;
	company_id: string;
	company_name?: string;
	role?: string;
	module: string;
}

/**
 * Handles SSO authentication from the main Engi platform.
 * Validates short-lived JWTs issued by engi-app's POST /api/v1/auth/module-token
 * and creates or retrieves the corresponding n8n user.
 */
@RestController('/sso/engi')
export class EngiSsoController {
	private readonly ssoSecret: string;

	constructor(
		private readonly logger: Logger,
		private readonly authService: AuthService,
		private readonly userRepository: UserRepository,
		private readonly authIdentityRepository: AuthIdentityRepository,
		private readonly passwordUtility: PasswordUtility,
		private readonly eventService: EventService,
	) {
		this.ssoSecret = process.env.MODULE_SSO_SECRET ?? '';
		if (!this.ssoSecret) {
			this.logger.warn(
				'MODULE_SSO_SECRET is not set. Engi SSO endpoint will reject all requests.',
			);
		}
	}

	/**
	 * GET /sso/engi?token=<jwt>
	 * Validates the token, provisions the user if needed, issues an n8n session cookie,
	 * and redirects to the editor.
	 */
	@Get('/', { skipAuth: true })
	async handleSso(req: AuthlessRequest, res: Response): Promise<void> {
		const token = req.query.token as string | undefined;

		if (!token) {
			throw new BadRequestError('Missing token parameter');
		}

		if (!this.ssoSecret) {
			throw new AuthError('SSO is not configured');
		}

		// Validate the JWT from engi-app.
		let payload: EngiTokenPayload;
		try {
			payload = jwt.verify(token, this.ssoSecret) as EngiTokenPayload;
		} catch (err) {
			this.logger.warn('Engi SSO token validation failed', { error: (err as Error).message });
			throw new AuthError('Invalid or expired SSO token');
		}

		if (!payload.email || !payload.user_id) {
			throw new AuthError('Invalid token payload');
		}

		// Find existing user by AuthIdentity or email.
		let user = await this.findUserByIdentity(payload.user_id);

		if (!user) {
			user = await this.findUserByEmail(payload.email);
		}

		if (!user) {
			// Auto-provision new user.
			user = await this.createUser(payload);
			this.logger.info('Engi SSO: provisioned new user', { email: payload.email });
		} else {
			// Ensure AuthIdentity link exists.
			await this.ensureIdentityLink(user, payload.user_id);
		}

		// Issue n8n session cookie and redirect to editor.
		this.authService.issueCookie(res, user, false);

		this.eventService.emit('user-logged-in', {
			user,
			authenticationMethod: 'email' as const,
		});

		res.redirect('/');
	}

	private async findUserByIdentity(engiUserId: string): Promise<User | null> {
		const identity = await this.authIdentityRepository.findOne({
			where: { providerId: engiUserId, providerType: PROVIDER_TYPE },
			relations: { user: true },
		});
		return identity?.user ?? null;
	}

	private async findUserByEmail(email: string): Promise<User | null> {
		return await this.userRepository.findOne({
			where: { email: email.toLowerCase() },
		});
	}

	private async createUser(payload: EngiTokenPayload): Promise<User> {
		const randomPassword = randomString(18);

		return await this.userRepository.manager.transaction(async (trx) => {
			const { user } = await this.userRepository.createUserWithProject(
				{
					email: payload.email.toLowerCase(),
					firstName: payload.email.split('@')[0],
					lastName: '',
					role: { slug: payload.role === 'admin' ? 'global:owner' : 'global:member' },
					password: await this.passwordUtility.hash(randomPassword),
				},
				trx,
			);

			await trx.save(
				trx.create(AuthIdentity, {
					providerId: payload.user_id,
					providerType: PROVIDER_TYPE,
					userId: user.id,
				}),
			);

			return user;
		});
	}

	private async ensureIdentityLink(user: User, engiUserId: string): Promise<void> {
		const existing = await this.authIdentityRepository.findOne({
			where: { userId: user.id, providerType: PROVIDER_TYPE },
		});

		if (!existing) {
			await this.authIdentityRepository.save(
				this.authIdentityRepository.create({
					providerId: engiUserId,
					providerType: PROVIDER_TYPE,
					userId: user.id,
				}),
			);
		}
	}
}
