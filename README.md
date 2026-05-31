# NeuraPath AI — Full Stack Platform

# NeuraPath AI

🌐 Live Demo: https://your-vercel-link.vercel.app

NeuraPath AI is an AI-powered learning platform designed to help students with career guidance, learning roadmaps, resume building, project discovery, and AI-powered assistance through Noir AI.

## Features

- AI Career Guidance
- Learning Roadmaps
- Resume Checklist
- Project Generator
- AI Tools Directory
- PromptVerse
- Blog & Resources
- Noir AI Assistant

## Tech Stack

- HTML
- CSS
- JavaScript
- Node.js
- GitHub
- Vercel

---

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
