import { z, ZodError } from "zod";
import { fromZodError } from 'zod-validation-error';

export const envSchema = z.object({
	BOT_TOKEN: z.string(),
	BOT_INFO: z.string(),
	/**
	 * Comma separated list of user ids
	 * Accept only messages from these users
	 *
	 * Example: 1234567890,0987654321
	 * Convert to: [1234567890, 0987654321]
	 *
	 */
	ALLOWED_USER_IDS: z.preprocess((val: unknown) => {
		if (val === '' || val === undefined || val === null) return [];
		if(typeof val === 'number') return [val];
		return typeof val === 'string' ? val.trim().split(',').map(Number) : [];
	}, z.array(z.number())),

	/**
	 * Telegram webhook URL
	 *
	 * Use in development mode only
	 */
	TELEGRAM_WEBHOOK_URL: z.string().optional(),
	/**
	 * Protected Bot
	 *
	 * @default true
	 */
	PROTECTED_BOT: z.boolean().default(true),
	/**
	 * Webhook Secret
	 *
	 * Use to verify the request is coming from Telegram
	 *
	 * When not set, it will automatically generate a secret
	 */
	WEBHOOK_SECRET: z.string().optional(),
	/**
	 * OpenAI API Key
	 */
	OPENAI_API_KEY: z.string(),
});

export function getEnv(env: unknown) {
	try {
		return envSchema.parse(env);
	} catch (error: unknown) {
		if (error instanceof ZodError) {
			console.error(fromZodError(error).message);
		} else {
			console.error('Unknown error', error);
		}
		throw new Error('Invalid environment variables');
	}
}

