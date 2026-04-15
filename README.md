# Rowboat Open

This project is an updated version of `Rowboat` focused on integrating `ChatGPT OAuth` as an AI provider inside `Rowboat`.

Unlike the upstream repository, this fork is documented around the implementation in this codebase rather than the original product marketing. In this version:
- `ChatGPT OAuth` is integrated as a dedicated AI provider
- the local-first `Rowboat` memory model and Markdown vault workflow are preserved
- local models, hosted providers, and `ChatGPT OAuth` can all be used
- the project remains extensible through `MCP` and local integrations

## What This Project Is

`Rowboat Open` uses local memory, notes, and user context to help with day-to-day work:
- meeting preparation based on accumulated context
- note, summary, and document generation
- workflows connected to email, calendar, and meeting notes
- AI-powered actions using the selected model provider

The main difference in this fork is that `ChatGPT OAuth` is added and supported as one of the primary ways to connect AI capabilities to `Rowboat`.

## Supported Model Modes

The project supports several model provider setups:
- **Local models** via `Ollama` or `LM Studio`
- **Hosted models** through an external API key or provider
- **ChatGPT OAuth** as an integrated AI provider in this fork

## Installation

**All release files:** https://github.com/rowboatlabs/rowboat/releases/latest

### Google setup

To connect `Gmail`, `Google Calendar`, and `Google Drive`, follow the instructions in [google-setup.md](/Users/alex/code/rowboat-open/google-setup.md:1).

### Voice input

To enable voice input and voice notes, add a `Deepgram` API key to `~/.rowboat/config/deepgram.json`

### Voice output

To enable voice output, add an `ElevenLabs` API key to `~/.rowboat/config/elevenlabs.json`

### Web search

To enable research search, add an `Exa` API key to `~/.rowboat/config/exa-search.json`

### External tools

To enable external tools, you can connect an `MCP` server or `Composio` by adding a key to `~/.rowboat/config/composio.json`

All API key files use the same format:

```json
{
  "apiKey": "<key>"
}
```

## Integrations

The project can work with data and context from:
- `Gmail`
- `Google Calendar`
- meeting notes
- the local Markdown vault
- external tools connected through `MCP`

## MCP And Extensions

`Rowboat Open` can be extended through **Model Context Protocol (MCP)**.

This makes it possible to connect:
- search
- databases
- CRM systems
- support tools
- automation tools
- internal team services

## Local-First Approach

- data is stored locally
- the main working memory is available as Markdown
- users control provider and integration configuration
- data is not locked into a proprietary cloud format
