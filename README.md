# Kronk Bot

> *The bot. The bot for your repo. The bot chosen especially for your repo.*

A self-hosted GitHub bot that responds to mentions in issues using an AI agent. Mention it in any issue or comment, and it reads your codebase to answer questions, explain code, or help with anything you ask.

## How it works

Kronk Bot polls GitHub for new issue comments containing its trigger word (default: `@kronk-bot`). When triggered, it spins up an AI agent with read-only access to the repository and posts the agent's response as a comment, including token usage and cost stats.

It automatically handles all repositories where the GitHub App is installed.

## GitHub App setup

1. Go to **GitHub Settings > Developer settings > GitHub Apps > New GitHub App**
2. Set a name, homepage URL, and **disable webhooks**
3. Under **Permissions**, grant the following:
   - **Repository permissions > Metadata:** Read-only
   - **Repository permissions > Contents:** Read and write
   - **Repository permissions > Issues:** Read and write
   - **Repository permissions > Pull requests:** Read and write
4. Create a **private key** and note your **App ID**
5. Install the app on the repositories you want it to monitor

## Running

**Locally:**
```bash
npm install
npx tsx src/index.ts
```

**Docker Compose:**
```bash
docker compose up -d
```

The `/data` volume persists the database, cloned repos, and agent sessions across restarts.

## Customizing the agent

The agent's behavior, persona, and guidelines are defined in [`agents/agent.md`](agents/agent.md). Edit it to change how the bot responds.

## Usage

Once running, mention the bot in any issue or comment on an installed repository:

```
@kronk-bot can you explain how the authentication flow works?
```

The bot will explore the codebase, generate a response, and post it as a comment.
