import { getEnv } from "./env";


/**
 * After running bot using `start`, it will remove the webhook and start polling.
 * So, after deploying the bot, we need to set the webhook again.
 */
export async function postDeploy() {
	const env = getEnv(process.env);
	console.log(`Setting webhook to ${env.TELEGRAM_WEBHOOK_URL.replace(env.BOT_TOKEN, '***')}`);
	await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/setWebhook?url=${env.TELEGRAM_WEBHOOK_URL}`);
}

postDeploy();