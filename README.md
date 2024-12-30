# FIDE Chess Master Bot

A powerful chess bot for Lichess that leverages advanced game analysis and UCI engine integration. Built with Node.js, this bot provides intelligent gameplay, real-time analysis, and automated match management.

## 🎯 Key Features

- **Advanced Chess Engine Integration**
  - UCI protocol support
  - Real-time position evaluation
  - Configurable engine parameters

- **Lichess Integration**
  - Automated game acceptance
  - Rating-based opponent matching
  - WebSocket game streaming
  - API rate limit handling

- **Smart Game Management**
  - Configurable playing sessions
  - Automatic break scheduling
  - Performance monitoring
  - Game history tracking

## 🚀 Quick Start

### Prerequisites
- Node.js 18.x
- A Lichess OAuth token
- A UCI-compatible chess engine

### Installation

```
git clone git@github.com:kevoconnell/chess-engine-llm.git

npm i 
```

[Get a Lichess personal token](https://lichess.org/account/oauth/token)

[Get a OpenAI API key](https://platform.openai.com/settings/organization/api-keys)

cp .env.example .env

enter in the variables made above

npm run dev


