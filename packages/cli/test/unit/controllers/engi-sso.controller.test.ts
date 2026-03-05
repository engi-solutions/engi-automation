import type { User } from '@n8n/db';
import jwt from 'jsonwebtoken';

/**
 * Unit tests for the Engi SSO controller logic.
 *
 * These tests validate the SSO token verification flow without requiring the
 * full n8n DI container. They test: JWT validation, token expiry, payload
 * extraction, and cross-service secret agreement.
 */

const SSO_SECRET = 'test-sso-secret-32-chars-minimum!';

interface EngiTokenPayload {
	user_id: string;
	email: string;
	company_id: string;
	company_name?: string;
	role?: string;
	module: string;
}

/** Helper: generate a valid SSO token (simulates engi-app's ModuleTokenGenerator). */
function generateSSOToken(
	payload: Partial<EngiTokenPayload> & { user_id: string; email: string; module: string },
	options?: { secret?: string; expiresIn?: string | number },
): string {
	return jwt.sign(
		{
			user_id: payload.user_id,
			email: payload.email,
			company_id: payload.company_id ?? 'company-001',
			company_name: payload.company_name ?? 'Test Company',
			role: payload.role ?? 'admin',
			module: payload.module,
		} satisfies EngiTokenPayload,
		options?.secret ?? SSO_SECRET,
		{ expiresIn: options?.expiresIn ?? '30s' },
	);
}

/** Helper: simulate what the SSO controller does to validate and extract a token. */
function validateSSOToken(
	token: string,
	secret: string = SSO_SECRET,
): { valid: true; payload: EngiTokenPayload } | { valid: false; error: string } {
	try {
		const payload = jwt.verify(token, secret) as EngiTokenPayload;
		if (!payload.email || !payload.user_id) {
			return { valid: false, error: 'Invalid token payload' };
		}
		return { valid: true, payload };
	} catch (err) {
		return { valid: false, error: (err as Error).message };
	}
}

/** Helper: determine n8n role from engi role (mirrors controller logic). */
function mapRole(engiRole?: string): string {
	return engiRole === 'admin' ? 'global:owner' : 'global:member';
}

describe('Engi SSO Controller Logic', () => {
	describe('Token validation', () => {
		it('should accept a valid token signed with the correct secret', () => {
			const token = generateSSOToken({
				user_id: 'user-001',
				email: 'user@example.com',
				module: 'automation',
			});

			const result = validateSSOToken(token);
			expect(result.valid).toBe(true);
			if (result.valid) {
				expect(result.payload.user_id).toBe('user-001');
				expect(result.payload.email).toBe('user@example.com');
				expect(result.payload.module).toBe('automation');
			}
		});

		it('should reject a token signed with a different secret', () => {
			const token = generateSSOToken(
				{
					user_id: 'user-001',
					email: 'user@example.com',
					module: 'automation',
				},
				{ secret: 'wrong-secret-from-different-env' },
			);

			const result = validateSSOToken(token, SSO_SECRET);
			expect(result.valid).toBe(false);
		});

		it('should reject an expired token', async () => {
			const token = generateSSOToken(
				{
					user_id: 'user-001',
					email: 'user@example.com',
					module: 'automation',
				},
				{ expiresIn: '1ms' },
			);

			// Wait for expiry.
			await new Promise((resolve) => setTimeout(resolve, 50));

			const result = validateSSOToken(token);
			expect(result.valid).toBe(false);
			if (!result.valid) {
				expect(result.error).toContain('jwt expired');
			}
		});

		it('should reject a completely invalid token string', () => {
			const result = validateSSOToken('not-a-jwt-at-all');
			expect(result.valid).toBe(false);
		});

		it('should reject a token with tampered payload', () => {
			const token = generateSSOToken({
				user_id: 'user-001',
				email: 'user@example.com',
				module: 'automation',
			});

			// Tamper with the payload (middle part of JWT).
			const parts = token.split('.');
			const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
			payload.role = 'superadmin';
			parts[1] = Buffer.from(JSON.stringify(payload)).toString('base64url');
			const tamperedToken = parts.join('.');

			const result = validateSSOToken(tamperedToken);
			expect(result.valid).toBe(false);
		});
	});

	describe('Payload extraction', () => {
		it('should extract all claims from a valid token', () => {
			const token = generateSSOToken({
				user_id: 'user-42',
				email: 'admin@acme.com',
				company_id: 'comp-99',
				company_name: 'Acme Corp',
				role: 'admin',
				module: 'automation',
			});

			const result = validateSSOToken(token);
			expect(result.valid).toBe(true);
			if (result.valid) {
				expect(result.payload).toMatchObject({
					user_id: 'user-42',
					email: 'admin@acme.com',
					company_id: 'comp-99',
					company_name: 'Acme Corp',
					role: 'admin',
					module: 'automation',
				});
			}
		});

		it('should handle optional fields (company_name, role)', () => {
			const token = jwt.sign(
				{
					user_id: 'user-001',
					email: 'user@test.com',
					company_id: 'comp-001',
					module: 'automation',
				},
				SSO_SECRET,
				{ expiresIn: '30s' },
			);

			const result = validateSSOToken(token);
			expect(result.valid).toBe(true);
			if (result.valid) {
				expect(result.payload.company_name).toBeUndefined();
				expect(result.payload.role).toBeUndefined();
			}
		});
	});

	describe('Role mapping', () => {
		it('should map admin to global:owner', () => {
			expect(mapRole('admin')).toBe('global:owner');
		});

		it('should map non-admin roles to global:member', () => {
			expect(mapRole('user')).toBe('global:member');
			expect(mapRole('viewer')).toBe('global:member');
			expect(mapRole(undefined)).toBe('global:member');
		});
	});

	describe('Cross-service token flow', () => {
		it('should produce tokens that both services can agree on', () => {
			// Simulate engi-app generating a token.
			const sharedSecret = 'shared-secret-between-services!!';
			const token = generateSSOToken(
				{
					user_id: 'usr-123',
					email: 'john@acme.com',
					company_id: 'acme-001',
					company_name: 'Acme',
					role: 'admin',
					module: 'automation',
				},
				{ secret: sharedSecret, expiresIn: '30s' },
			);

			// Simulate engi-automation validating the same token.
			const result = validateSSOToken(token, sharedSecret);
			expect(result.valid).toBe(true);
			if (result.valid) {
				expect(result.payload.user_id).toBe('usr-123');
				expect(result.payload.email).toBe('john@acme.com');
				expect(result.payload.module).toBe('automation');
				expect(mapRole(result.payload.role)).toBe('global:owner');
			}
		});

		it('should fail when services have different secrets (misconfiguration)', () => {
			const token = generateSSOToken(
				{
					user_id: 'usr-123',
					email: 'john@acme.com',
					module: 'automation',
				},
				{ secret: 'engi-app-secret-value-here!!!!!' },
			);

			// engi-automation has a different secret.
			const result = validateSSOToken(token, 'engi-automation-different-secret');
			expect(result.valid).toBe(false);
		});

		it('should generate user creation data correctly from token', () => {
			const token = generateSSOToken({
				user_id: 'usr-new',
				email: 'New.User@Example.COM',
				company_id: 'comp-001',
				role: 'user',
				module: 'automation',
			});

			const result = validateSSOToken(token);
			expect(result.valid).toBe(true);
			if (result.valid) {
				const { payload } = result;

				// Simulate what the controller does for user creation.
				const userData: Partial<User> = {
					email: payload.email.toLowerCase(),
					firstName: payload.email.split('@')[0],
					lastName: '',
				};
				const roleSlug = mapRole(payload.role);

				expect(userData.email).toBe('new.user@example.com');
				expect(userData.firstName).toBe('New.User');
				expect(roleSlug).toBe('global:member');
			}
		});
	});

	describe('Token expiry timing', () => {
		it('should create tokens with correct TTL', () => {
			const token = generateSSOToken(
				{
					user_id: 'user-001',
					email: 'user@test.com',
					module: 'automation',
				},
				{ expiresIn: '30s' },
			);

			const decoded = jwt.decode(token) as { exp: number; iat: number };
			expect(decoded.exp - decoded.iat).toBe(30);
		});

		it('should accept a token within its validity window', () => {
			const token = generateSSOToken(
				{
					user_id: 'user-001',
					email: 'user@test.com',
					module: 'automation',
				},
				{ expiresIn: '5s' },
			);

			// Immediately verify — should be within window.
			const result = validateSSOToken(token);
			expect(result.valid).toBe(true);
		});
	});
});
