# Claude Bot

A modular Claude AI bot that integrates with various messaging platforms and responds to prompts when mentioned by name.

## Overview

Claude Bot listens for messages across supported messaging platforms and responds using Anthropic's Claude API whenever the bot is directly mentioned. Each platform adapter is independent, making it easy to add new integrations without touching the core bot logic. The bot is fully containerized for cloud-native deployment on any container platform.

## Features

- Responds to direct mentions (`@claude`, `@bot`, or a configured name) in supported channels
- Multi-platform support with a shared Claude AI backend
- Configurable bot name, personality, and system prompt per platform
- Conversation context tracking within threads or DMs
- Easily extensible — add new platform adapters with minimal boilerplate
- Container-ready with Docker and Docker Compose for cloud-native deployment

## Supported Platforms

| Platform  | Status       | Notes                                              |
|-----------|--------------|----------------------------------------------------|
| Discord   | Planned      | Official Bot API                                   |
| Slack     | Planned      | Official Bot API via Socket Mode                   |
| Telegram  | Planned      | Official Bot API                                   |
| WhatsApp  | Planned      | WhatsApp Business Cloud API (Meta)                 |
| WeChat    | Planned      | Unofficial bridge via [Wechaty](https://wechaty.js.org/) |

> **Note:** WeChat does not provide an official public bot API. The WeChat adapter uses Wechaty, an open-source conversational RPA SDK, which may require a Wechaty Puppet provider or token depending on the protocol used.

## Prerequisites

- [Node.js](https://nodejs.org/) v18+ (or Docker — see [Containerization](#containerization))
- An [Anthropic API key](https://console.anthropic.com/)
- Bot credentials for each platform you want to enable (see platform setup below)

## Installation

### Local

```bash
git clone https://github.com/your-username/claude-bot.git
cd claude-bot
npm install
```

### Docker

```bash
git clone https://github.com/your-username/claude-bot.git
cd claude-bot
cp .env.example .env   # fill in your credentials
docker compose up -d
```

## Configuration

Copy the example environment file and fill in your credentials:

```bash
cp .env.example .env
```

**.env**

```env
# Anthropic
ANTHROPIC_API_KEY=your_anthropic_api_key

# Bot identity
BOT_NAME=claude

# Claude model to use
CLAUDE_MODEL=claude-sonnet-4-6

# Discord (optional)
DISCORD_BOT_TOKEN=your_discord_bot_token
DISCORD_CLIENT_ID=your_discord_client_id

# Slack (optional)
SLACK_BOT_TOKEN=xoxb-your-slack-bot-token
SLACK_APP_TOKEN=xapp-your-slack-app-token

# Telegram (optional)
TELEGRAM_BOT_TOKEN=your_telegram_bot_token

# WhatsApp Business Cloud API (optional)
WHATSAPP_ACCESS_TOKEN=your_whatsapp_access_token
WHATSAPP_PHONE_NUMBER_ID=your_phone_number_id
WHATSAPP_VERIFY_TOKEN=your_webhook_verify_token

# WeChat / Wechaty (optional)
WECHATY_PUPPET=wechaty-puppet-wechat4u
WECHATY_TOKEN=your_wechaty_puppet_service_token
```

Only include the credentials for the platforms you intend to run.

## Platform Setup

### Discord

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications) and create a new application.
2. Under **Bot**, create a bot user and copy the token into `DISCORD_BOT_TOKEN`.
3. Enable **Message Content Intent** under Privileged Gateway Intents.
4. Under **OAuth2 > URL Generator**, select the `bot` scope with **Send Messages** and **Read Message History** permissions. Use the generated URL to invite the bot to your server.

### Slack

1. Go to [api.slack.com/apps](https://api.slack.com/apps) and create a new app.
2. Enable **Socket Mode** and generate an app-level token (`xapp-...`) for `SLACK_APP_TOKEN`.
3. Under **OAuth & Permissions**, add the `chat:write`, `app_mentions:read`, and `im:history` scopes. Install the app and copy the bot token (`xoxb-...`) for `SLACK_BOT_TOKEN`.
4. Under **Event Subscriptions**, subscribe to `app_mention` and `message.im` events.

### Telegram

1. Message [@BotFather](https://t.me/BotFather) on Telegram and use `/newbot` to create a bot.
2. Copy the provided token into `TELEGRAM_BOT_TOKEN`.
3. To receive group messages, disable privacy mode with `/setprivacy` → Disable in BotFather, or use commands.

### WhatsApp

WhatsApp integration uses the [WhatsApp Business Cloud API](https://developers.facebook.com/docs/whatsapp/cloud-api) provided by Meta. A verified Meta Business account is required.

1. Go to [developers.facebook.com](https://developers.facebook.com/) and create an app with the **WhatsApp** product.
2. In the **WhatsApp > API Setup** section, copy the temporary or permanent access token into `WHATSAPP_ACCESS_TOKEN` and the Phone Number ID into `WHATSAPP_PHONE_NUMBER_ID`.
3. Under **Webhooks**, configure the callback URL to point to your bot's `/webhook/whatsapp` endpoint and set a verify token — copy it into `WHATSAPP_VERIFY_TOKEN`.
4. Subscribe to the `messages` webhook field.

> The bot must be publicly reachable for webhook delivery. Use a service like [ngrok](https://ngrok.com/) for local development, or deploy to a cloud environment.

### WeChat

WeChat integration uses [Wechaty](https://wechaty.js.org/), an open-source RPA SDK for WeChat. Choose a puppet provider based on your needs:

| Puppet                       | Protocol           | Requires Token |
|------------------------------|--------------------|----------------|
| `wechaty-puppet-wechat4u`    | Web (free)         | No             |
| `wechaty-puppet-padlocal`    | Pad protocol       | Yes (paid)     |
| `wechaty-puppet-service`     | gRPC service       | Yes            |

1. Set `WECHATY_PUPPET` to your chosen puppet package name.
2. If your puppet requires a token, set `WECHATY_TOKEN` accordingly.
3. On first run, a QR code will be printed in the console — scan it with the WeChat mobile app to log in.

> **Important:** Web-protocol puppets (`wechat4u`) may be subject to WeChat account restrictions. Use a dedicated or test account.

## Usage

### Local

Start all configured platform adapters:

```bash
npm start
```

Start a single platform:

```bash
npm run start:discord
npm run start:slack
npm run start:telegram
npm run start:whatsapp
npm run start:wechat
```

### Docker

```bash
# Start all adapters
docker compose up -d

# View logs
docker compose logs -f

# Stop
docker compose down
```

### Triggering the bot

Mention the bot by its configured name in any supported channel:

```
@claude What is the capital of France?
```

The bot will reply in the same channel or thread using Claude AI.

## Project Structure

```
claude-bot/
├── src/
│   ├── core/
│   │   └── claude.js          # Anthropic API client & response logic
│   ├── adapters/
│   │   ├── discord.js         # Discord platform adapter
│   │   ├── slack.js           # Slack platform adapter
│   │   ├── telegram.js        # Telegram platform adapter
│   │   ├── whatsapp.js        # WhatsApp Business Cloud API adapter
│   │   └── wechat.js          # WeChat adapter (via Wechaty)
│   └── index.js               # Entry point — starts enabled adapters
├── Dockerfile
├── docker-compose.yml
├── .dockerignore
├── .env.example
├── package.json
└── README.md
```

## Containerization

The bot ships with a multi-stage `Dockerfile` and a `docker-compose.yml` for local and cloud-native deployments.

### Build the image

```bash
docker build -t claude-bot .
```

### Run with Docker

```bash
docker run --env-file .env claude-bot
```

### Run with Docker Compose

```bash
docker compose up -d
```

### Cloud deployment

The image can be deployed to any container platform:

| Platform              | Command / Notes                                              |
|-----------------------|--------------------------------------------------------------|
| **Google Cloud Run**  | `gcloud run deploy claude-bot --image gcr.io/<project>/claude-bot` |
| **AWS ECS / Fargate** | Push to ECR, create a task definition, and run as a service  |
| **Azure Container Apps** | `az containerapp create --image ...`                      |
| **Kubernetes**        | Use the provided image in a `Deployment` manifest; store secrets in `Secret` objects |
| **Railway / Render**  | Connect your repo — they auto-detect the Dockerfile          |

For platforms that require webhook callbacks (WhatsApp), ensure the container is exposed via a public ingress or load balancer and the webhook URL is updated accordingly.

## Adding a New Platform

1. Create `src/adapters/<platform>.js`.
2. Listen for mention events from the platform's SDK.
3. Extract the message text, strip the bot mention, and pass it to the shared `claude.js` client.
4. Send the response back through the platform's API.
5. Add the platform's environment variables to `.env.example` and the reference table below.

Refer to an existing adapter (e.g., `discord.js`) as a template.

## Environment Variables Reference

| Variable                  | Required  | Description                                         |
|---------------------------|-----------|-----------------------------------------------------|
| `ANTHROPIC_API_KEY`       | Yes       | Your Anthropic API key                              |
| `BOT_NAME`                | No        | Name the bot listens for (default: `claude`)        |
| `CLAUDE_MODEL`            | No        | Claude model ID (default: `claude-sonnet-4-6`)      |
| `DISCORD_BOT_TOKEN`       | Discord   | Discord bot token                                   |
| `DISCORD_CLIENT_ID`       | Discord   | Discord application client ID                       |
| `SLACK_BOT_TOKEN`         | Slack     | Slack bot OAuth token                               |
| `SLACK_APP_TOKEN`         | Slack     | Slack app-level token (Socket Mode)                 |
| `TELEGRAM_BOT_TOKEN`      | Telegram  | Telegram bot token from BotFather                   |
| `WHATSAPP_ACCESS_TOKEN`   | WhatsApp  | Meta WhatsApp Business Cloud API access token       |
| `WHATSAPP_PHONE_NUMBER_ID`| WhatsApp  | Phone Number ID from Meta Developer Console         |
| `WHATSAPP_VERIFY_TOKEN`   | WhatsApp  | Webhook verify token (any secret string you choose) |
| `WECHATY_PUPPET`          | WeChat    | Wechaty puppet package name                         |
| `WECHATY_TOKEN`           | WeChat    | Puppet service token (if required by puppet)        |

## License

MIT
