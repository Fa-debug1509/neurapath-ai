# NeuraPath AI — Full Stack Platform

## Project Structure
```
neurapath/
├── server.js          ← Node.js backend (zero dependencies, pure built-ins)
├── package.json       ← Project metadata
├── README.md          ← This file
├── public/
│   └── index.html     ← Complete frontend SPA (all pages)
└── data/              ← JSON file-based database (auto-created)
    ├── subscribers.json
    ├── contacts.json
    ├── savedPrompts.json
    ├── chatHistory.json
    └── feedback.json
```

## How to Run
1. Make sure Node.js is installed (v14+)
2. Open terminal in this folder
3. Run: node server.js
4. Open browser: http://localhost:3000

## API Endpoints
- GET  /api/health
- POST /api/noir/chat
- GET  /api/careers
- GET  /api/projects
- GET  /api/roadmaps
- GET  /api/prompts
- POST /api/prompts/save
- GET  /api/tools
- GET  /api/blog
- POST /api/contact
- POST /api/subscribe
- GET  /api/stats

## No npm install needed — uses only Node.js built-ins!
