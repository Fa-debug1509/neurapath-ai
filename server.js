/**
 * NeuraPath AI — Full-Stack Backend Server
 * Built with pure Node.js (zero npm dependencies)
 * REST API + Static File Server
 */

const http   = require('http');
const https  = require('https');
const fs     = require('fs');
const path   = require('path');
const url    = require('url');
const crypto = require('crypto');

// ── Load .env file if present ────────────────────────────────────────────────
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  const lines = fs.readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
    if (key && !process.env[key]) process.env[key] = val;
  }
}

const PORT = 3000;
const DATA_DIR = path.join(__dirname, 'data');

// ── Pure Node.js PDF text extractor (no dependencies) ──────────────────────
function extractTextFromPdfBuffer(buf) {
  try {
    const str = buf.toString('binary');
    const texts = [];
    // Extract text from BT...ET blocks (standard PDF text objects)
    const btEtRegex = /BT([\s\S]*?)ET/g;
    let match;
    while ((match = btEtRegex.exec(str)) !== null) {
      const block = match[1];
      // Tj and TJ operators
      const tjRegex = /\(((?:[^\\)]|\\[\s\S])*)\)\s*Tj/g;
      const tjArrRegex = /\[((?:[^\]]*\([^)]*\)[^\]]*)*)\]\s*TJ/g;
      let m2;
      while ((m2 = tjRegex.exec(block)) !== null) {
        texts.push(decodePdfString(m2[1]));
      }
      while ((m2 = tjArrRegex.exec(block)) !== null) {
        const inner = m2[1];
        const parts = [];
        const pRegex = /\(((?:[^\\)]|\\[\s\S])*)\)/g;
        let m3;
        while ((m3 = pRegex.exec(inner)) !== null) parts.push(decodePdfString(m3[1]));
        if (parts.length) texts.push(parts.join(''));
      }
    }
    // Also grab any stream content that looks like readable text
    const streamRegex = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
    while ((match = streamRegex.exec(str)) !== null) {
      const s = match[1];
      if (/^[\x20-\x7E\n\r\t]{40,}$/.test(s.trim().slice(0, 200))) {
        texts.push(s.replace(/[^\x20-\x7E\n\r\t]/g, ' ').trim());
      }
    }
    const result = texts.join(' ')
      .replace(/\\n/g, '\n').replace(/\\r/g, '').replace(/\\t/g, ' ')
      .replace(/\s{3,}/g, '  ').trim();
    return result;
  } catch(e) {
    return '';
  }
}

function decodePdfString(s) {
  return s
    .replace(/\\n/g, ' ').replace(/\\r/g, '').replace(/\\t/g, ' ')
    .replace(/\\\\/g, '\\').replace(/\\'/g, "'").replace(/\\\(/g, '(').replace(/\\\)/g, ')')
    .replace(/[^\x20-\x7E]/g, ' ').trim();
}



// ── ensure data directory + seed files ──────────────────────────────────────
function ensureData(file, defaultVal) {
  const fp = path.join(DATA_DIR, file);
  if (!fs.existsSync(fp)) fs.writeFileSync(fp, JSON.stringify(defaultVal, null, 2));
  return fp;
}

const FILES = {
  subscribers: ensureData('subscribers.json', []),
  contacts:    ensureData('contacts.json',    []),
  savedPrompts:ensureData('savedPrompts.json',{}),
  chatHistory: ensureData('chatHistory.json', []),
  feedback:    ensureData('feedback.json',    []),
};

function readJSON(file)       { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function writeJSON(file, val) { fs.writeFileSync(file, JSON.stringify(val, null, 2)); }

// ── MIME types ──────────────────────────────────────────────────────────────
const MIME = {
  '.html':'text/html', '.css':'text/css', '.js':'application/javascript',
  '.json':'application/json', '.png':'image/png', '.jpg':'image/jpeg',
  '.svg':'image/svg+xml', '.ico':'image/x-icon', '.woff2':'font/woff2',
};

// ── Helper: JSON response ────────────────────────────────────────────────────
function sendJSON(res, status, data) {
  res.writeHead(status, {
    'Content-Type':'application/json',
    'Access-Control-Allow-Origin':'*',
    'Access-Control-Allow-Methods':'GET,POST,PUT,DELETE,OPTIONS',
    'Access-Control-Allow-Headers':'Content-Type',
  });
  res.end(JSON.stringify(data));
}

function readBody(req, maxBytes = 10 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > maxBytes) { req.destroy(); return reject(new Error('Payload too large')); }
      body += chunk;
    });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch(e) { resolve({}); }
    });
    req.on('error', reject);
  });
}

// ── Noir AI Response Engine ──────────────────────────────────────────────────
const NOIR_KNOWLEDGE = {
  greetings: ['hi','hello','hey','good morning','good evening','what\'s up','sup'],
  career: ['career','job','become','engineer','developer','scientist','analyst','designer','manager','researcher'],
  project: ['project','build','portfolio','idea','suggest','create','make'],
  resume: ['resume','cv','improve','review','ats','keyword','format'],
  interview: ['interview','prepare','questions','practice','behavioral','technical','hr'],
  learn: ['learn','start','beginner','roadmap','study','how to','tutorial','course'],
  internship: ['internship','job hunt','apply','hire','job search','placement'],
  python: ['python','code','programming','script','function','class','loop'],
  ai: ['ai','artificial intelligence','machine learning','deep learning','neural','nlp','llm','gpt'],
  webdev: ['web','html','css','javascript','react','node','frontend','backend','fullstack'],
  data: ['data science','pandas','numpy','analysis','visualization','tableau','sql'],
  skill: ['skill','skill gap','missing','gap','weakness','strength','improve'],
  prompt: ['prompt','prompting','prompt engineering','chatgpt','claude'],
};

function detectIntent(msg) {
  const lower = msg.toLowerCase();
  for (const [intent, keywords] of Object.entries(NOIR_KNOWLEDGE)) {
    if (keywords.some(k => lower.includes(k))) return intent;
  }
  return 'general';
}

const NOIR_RESPONSES = {
  greetings: [
    "Hey there! 👋 I'm Noir, your AI learning & career companion. What are you working towards today?",
    "Hello! Great to see you. I'm here to help with career guidance, learning paths, projects, and more. What's on your mind?",
    "Hi! I'm Noir ✦ — ask me anything about AI careers, learning roadmaps, resume tips, or projects!",
  ],
  career: (msg) => {
    if (msg.includes('ai') || msg.includes('machine learning') || msg.includes('ml'))
      return "🤖 **AI/ML Engineer Path:**\n\n1. **Python** — your core language\n2. **Math** — Linear Algebra, Calculus, Statistics\n3. **ML Frameworks** — Scikit-learn → TensorFlow/PyTorch\n4. **Projects** — build 3+ end-to-end ML projects\n5. **Deploy** — learn MLOps basics\n6. **Contribute** — Kaggle competitions + open source\n\nTimeline: 12–18 months with consistent daily practice. Want a detailed week-by-week plan?";
    if (msg.includes('web') || msg.includes('frontend') || msg.includes('backend'))
      return "🌐 **Web Developer Path:**\n\n1. **HTML + CSS** — structure & styling\n2. **JavaScript (ES6+)** — the backbone\n3. **React.js** — dominant frontend framework\n4. **Node.js + Express** — backend APIs\n5. **PostgreSQL / MongoDB** — databases\n6. **Deploy on Vercel / AWS**\n\nTimeline: 8–12 months to job-ready. Want me to build you a custom roadmap?";
    if (msg.includes('data'))
      return "📊 **Data Scientist Path:**\n\n1. **Python + Pandas + NumPy** — data manipulation\n2. **Statistics & Probability** — the foundation\n3. **SQL** — query databases\n4. **Visualization** — Matplotlib, Seaborn, Tableau\n5. **Machine Learning** — regression to ensemble models\n6. **Portfolio** — Kaggle + real-world datasets\n\nTimeline: 10–14 months. Shall I suggest specific projects?";
    return "💼 **Career Planning Tips:**\n\nTo land a great tech role, focus on:\n\n✅ Build 3-4 strong portfolio projects\n✅ Earn 1-2 industry certifications\n✅ Optimize your LinkedIn profile fully\n✅ Contribute to open source (even small fixes count)\n✅ Network with professionals in your target field\n✅ Apply early — most roles get filled before deadlines\n\nWhich specific career are you targeting? I can give you a precise roadmap!";
  },
  project: () => "💡 **Portfolio Project Ideas:**\n\n🔵 **Beginner:**\n• Personal portfolio website\n• CLI expense tracker\n• Weather app with API\n\n🟣 **Intermediate:**\n• AI Resume Analyzer\n• Internship Tracker Dashboard\n• Real-time Chat App\n• Movie Recommendation Engine\n\n🔴 **Advanced:**\n• Full-stack SaaS with authentication\n• Fine-tuned LLM chatbot\n• Fraud Detection System\n• AI-powered code reviewer\n\nWhich level are you at? I'll give detailed implementation guidance!",
  resume: () => "📄 **Resume Improvement Guide:**\n\n✅ **Strong action verbs** — Built, Developed, Optimized, Led\n✅ **Quantify achievements** — 'Reduced load time by 40%', not 'improved performance'\n✅ **ATS optimization** — mirror keywords from the job description\n✅ **Projects section** — 2-4 projects with GitHub links\n✅ **Clean format** — no tables, no graphics (ATS can't read them)\n✅ **One page** — for entry-level and students\n✅ **Strong summary** — 2-3 sentences that sell your value\n\nWant me to review specific bullet points? Paste them and I'll rewrite them!",
  interview: () => "🎤 **Interview Preparation Strategy:**\n\n**Technical:**\n• Practice DSA on LeetCode (Easy → Medium first)\n• Review core CS fundamentals\n• Be able to explain every project on your resume deeply\n\n**Behavioral (STAR format):**\n• Situation → Task → Action → Result\n• Prepare 6-8 STAR stories that cover teamwork, challenge, leadership, failure\n\n**HR Round:**\n• Research the company thoroughly\n• Prepare for 'Tell me about yourself' (90 seconds)\n• Have 3-5 thoughtful questions ready for the interviewer\n\n**Mindset:**\n• Mock interviews help massively — try Pramp or Interviewing.io\n\nWant me to run a mock interview with you?",
  learn: (msg) => {
    if (msg.includes('ai') || msg.includes('machine'))
      return "📚 **Learning AI from Scratch — 5-Step Plan:**\n\n**Month 1:** Python fundamentals + basic math\n**Month 2:** Statistics + intro to ML concepts\n**Month 3:** Scikit-learn + first ML projects\n**Month 4:** Deep learning with TensorFlow/PyTorch\n**Month 5:** Specialization (NLP or Computer Vision)\n**Month 6+:** MLOps + job applications\n\n**Free resources:** fast.ai, deeplearning.ai, Kaggle\n**Daily commitment:** 1-2 hours minimum\n\nShall I break this into weekly tasks?";
    return "📚 **Learning Strategy for Tech:**\n\n1. **Pick ONE skill** — don't scatter focus\n2. **Follow a structured roadmap** — check our Roadmaps section\n3. **Build daily** — 30-60 mins of consistent practice compounds fast\n4. **Project-first learning** — always apply what you learn\n5. **Community** — join Discord servers, GitHub discussions\n6. **Document progress** — tweet/post what you build\n\nWhat specific skill are you starting with? I'll give you a day-by-day first-week plan!";
  },
  internship: () => "🎓 **Internship Landing Strategy:**\n\n**Where to apply:** LinkedIn, Unstop, Internshala, AngelList, company career pages\n\n**Resume:** Tailor to each JD, quantify everything, add GitHub profile\n\n**Networking (the real secret):** Alumni outreach > mass applying. Attend tech events, join communities\n\n**Apply early:** Most internships fill 6-8 weeks before the listed deadline!\n\n**DSA prep:** Even for product/design roles, many companies test basic logic\n\n**Follow up:** If no response in 1 week after applying, send a polite follow-up email\n\nCheck out the Internship Hub for our complete 8-module guide!",
  python: () => "🐍 **Python Learning Path:**\n\n**Week 1-2:** Variables, loops, functions, lists, dicts\n**Week 3-4:** OOP, file handling, error handling\n**Week 5-6:** Libraries — NumPy, Pandas, Matplotlib\n**Week 7-8:** Build 2 projects (CLI app + data project)\n\n**Best free resource:** Python.org tutorial → then freeCodeCamp\n**Practice:** HackerRank Python challenges daily\n**Projects:** Expense tracker → web scraper → data dashboard\n\nWhat's your current Python level? I'll tailor this plan.",
  ai: () => "🤖 **The AI Ecosystem Explained:**\n\n**Machine Learning** — algorithms that learn from data (Scikit-learn)\n**Deep Learning** — neural networks (TensorFlow, PyTorch)\n**NLP** — language understanding (Hugging Face, spaCy)\n**Computer Vision** — image/video analysis (OpenCV, YOLO)\n**LLMs** — large language models like GPT, Claude\n**MLOps** — deploying & managing ML in production\n\n**2025 hot areas:** RAG systems, fine-tuning open models, AI agents, multimodal AI\n\nWhich area excites you most? I can build you a specialized study plan!",
  webdev: () => "🌐 **Web Dev in 2025 — The Stack That Gets Hired:**\n\n**Frontend:** HTML + CSS + JavaScript → React (must-know)\n**Backend:** Node.js + Express OR Python + FastAPI\n**Database:** PostgreSQL (SQL) + MongoDB (NoSQL basics)\n**Auth:** JWT + OAuth\n**Deployment:** Vercel (frontend) + Railway/Render (backend)\n**Version control:** Git + GitHub (non-negotiable)\n\n**Bonus skills that stand out:** TypeScript, Docker basics, WebSockets\n\nTimeline to first job: 8-12 months focused. Check our Web Dev Roadmap for the full breakdown!",
  data: () => "📊 **Data Science Toolkit for 2025:**\n\n**Core libraries:** Pandas, NumPy, Matplotlib, Seaborn\n**ML:** Scikit-learn, XGBoost, LightGBM\n**Databases:** SQL (PostgreSQL), BigQuery\n**Visualization:** Tableau, Power BI, Plotly\n**Statistics:** Hypothesis testing, A/B testing, regression\n**Notebooks:** Jupyter, Google Colab\n\n**Best project for portfolio:** An end-to-end analysis of a real dataset with a business question, EDA, model, and Tableau dashboard\n\nWant me to suggest a specific dataset and project idea?",
  skill: () => "🔍 **Skill Gap Analysis Framework:**\n\n**Step 1:** List your target job's requirements (copy from 5 job descriptions)\n**Step 2:** Rate yourself 1-5 on each skill honestly\n**Step 3:** Identify the top 3 gaps that appear in 4+ job postings\n**Step 4:** Create a 90-day plan focused ONLY on those gaps\n**Step 5:** Build a project demonstrating each gap skill\n\n**Common gaps for tech students:**\n• System design basics\n• Git workflow (branching, PRs, code review)\n• Testing (unit tests, integration tests)\n• Cloud basics (AWS/GCP free tier)\n• Communication & documentation skills\n\nTell me your target role and I'll run a custom gap analysis!",
  prompt: () => "✨ **Prompt Engineering Fundamentals:**\n\n**Core principles:**\n1. **Be specific** — vague prompts get vague answers\n2. **Provide context** — your role, goal, constraints\n3. **Use examples** — 'Like this: [example]'\n4. **Chain of thought** — 'Think step by step'\n5. **Output format** — 'Respond in bullet points / JSON / table'\n\n**Power techniques:**\n• Role prompting: 'You are a senior software engineer...'\n• Few-shot: Give 2-3 examples before asking\n• Self-consistency: Ask for multiple approaches\n• Iterative refinement: Build on previous outputs\n\nCheck PromptVerse for 70+ curated prompts across 7 categories!",
  general: [
    "Great question! I'm designed to help with tech learning, career planning, projects, and professional growth. Could you give me a bit more context about what you're trying to achieve?",
    "I'm here to help! NeuraPath AI has resources on Career Mentoring, Learning Roadmaps, Projects, Internships, Resume Analysis, and AI Prompts. What would be most useful for you right now?",
    "Interesting! Let me think about that... I'd suggest exploring our Learning Roadmaps for structured guidance, or the Career Mentor section for detailed career paths. What's your main goal?",
    "That's something worth digging into. Can you tell me more about your current skill level and what you're working towards? The more specific you are, the better I can tailor my advice.",
    "Good thinking! I recommend starting with a clear goal, then building backwards to identify what skills, projects, and certifications you need. What role or skill are you targeting?",
  ]
};

function getNoirReply(message) {
  const intent = detectIntent(message);
  const lower = message.toLowerCase();
  const resp = NOIR_RESPONSES[intent];
  if (!resp) return NOIR_RESPONSES.general[Math.floor(Math.random() * NOIR_RESPONSES.general.length)];
  if (typeof resp === 'function') return resp(lower);
  if (Array.isArray(resp)) return resp[Math.floor(Math.random() * resp.length)];
  return resp;
}

// ── Prompt Library Data ──────────────────────────────────────────────────────
const PROMPTS = {
  "Study Prompts": [
    "Explain [concept] as if I'm a complete beginner. Use simple analogies and avoid jargon.",
    "Create a 30-minute study plan to understand [topic]. Break it into focused segments.",
    "Generate 10 quiz questions on [subject] from easy to hard, with correct answers.",
    "Summarize this research paper in 5 key bullet points focusing on main findings.",
    "Create a comparison table between [A] and [B] across 5 important dimensions.",
    "I'm confused about [concept]. Explain it 3 different ways using different analogies.",
    "Build a mind map structure for everything I need to know about [topic].",
    "Create 15 spaced-repetition flashcards for [topic] with questions and brief answers.",
    "What are the top 5 misconceptions beginners have about [subject]? Why is each wrong?",
    "Teach me [topic] using the Feynman technique — explain simply, find gaps, simplify again.",
    "What are the 3 most important things to understand about [topic] before moving on?",
    "Create a 7-day learning schedule to master [skill] with specific daily tasks.",
  ],
  "Coding Prompts": [
    "Review this code and identify bugs, performance issues, and improvements. Then provide corrected version.",
    "Write a Python function to [task]. Include docstrings, type hints, and unit tests.",
    "Explain this code line by line as if I'm learning it for the first time: [paste code]",
    "Convert this Python code to JavaScript and explain the key differences in syntax and approach.",
    "What design pattern best solves [problem]? Show a clean example implementation.",
    "Debug this code: [paste code]. Explain the root cause and the fix clearly.",
    "Write a REST API endpoint in [framework] that handles [task] with proper error handling.",
    "Refactor this code to be more readable, efficient, and follow best practices: [paste code]",
    "What are the time and space complexities of this algorithm? Can you optimize it?",
    "Create a beginner coding challenge for [concept] with hints and a step-by-step solution.",
    "Explain the difference between [async/sync | SQL/NoSQL | REST/GraphQL] with real examples.",
    "Generate comprehensive documentation for this function: [paste code]",
  ],
  "Resume Prompts": [
    "Improve this resume bullet point to be more achievement-focused and impactful: [paste bullet]",
    "Write a 2-3 sentence resume summary for a [role] with [X years] experience in [skills].",
    "Identify keywords from this job description I should include in my resume: [paste JD]",
    "Rewrite this experience section to better match this job description: [paste both]",
    "List 5 strong action verbs to replace 'worked on', 'helped with', and 'responsible for'.",
    "Review my resume and score it: keywords, readability, structure, achievements, ATS compatibility.",
    "Turn this project description into 3 powerful resume bullet points: [paste description]",
    "Suggest 10 quantifiable achievement examples for someone with a background in [field].",
    "How should I present a career gap of [duration] honestly and positively on my resume?",
    "Write a LinkedIn summary for a [role] with experience in [skills] seeking [goal].",
    "What's missing from this skills section for a [role] job application? [paste section]",
    "Give me 5 resume templates structures for a [student/junior developer/data analyst].",
  ],
  "Interview Preparation": [
    "Give me 10 common behavioral interview questions for [role] with STAR format example answers.",
    "I'm interviewing at [company] for [role]. What 5 technical concepts should I review?",
    "Ask me 5 medium-difficulty [Python/SQL/JavaScript] coding interview questions with hints.",
    "How should I answer 'Tell me about yourself' for a [role] with background in [skills]?",
    "What are the 3 best questions to ask the interviewer at the end of a [role] interview?",
    "Simulate a mock technical interview for [topic]. Ask questions, evaluate, give feedback.",
    "I answered this interview question poorly: [paste question + answer]. What should I have said?",
    "How do I explain my portfolio project to a non-technical interviewer in 2 minutes?",
    "What salary should I negotiate for a [role] with [X years] experience in [city]?",
    "Write a professional follow-up email to send after my interview with [company] for [role].",
    "Evaluate this technical answer and give honest feedback: Q: [question] A: [your answer]",
    "Create a 2-week interview prep plan for a [role] interview at a [company type].",
  ],
  "Productivity Prompts": [
    "Create a weekly study schedule for mastering [subject] with [X hours] available daily.",
    "Help me apply Pomodoro technique to studying [topics] over the next 3 hours.",
    "I need to learn [skill] in [timeframe]. Build an aggressive but realistic daily plan.",
    "Suggest 5 science-backed ways to reduce procrastination while studying [subject].",
    "Help me do a weekly review: What went well? What didn't? What's the focus next week?",
    "Break this overwhelming project into manageable daily tasks for 2 weeks: [description]",
    "What's the most efficient learning order for these 6 topics: [list them]?",
    "Design a morning routine for a student who wants 2 productive coding hours before class.",
    "Build a habit tracking framework for my goals: [list goals]. Include a scoring system.",
    "I have [hours] per day. How do I split time between [skill A], [skill B], and [skill C]?",
    "Help me eliminate decision fatigue in my study routine for the next 30 days.",
    "Create a 'no zero days' challenge plan for learning [skill] for the next 21 days.",
  ],
  "Career Development": [
    "I want to transition from [current] to [target role]. Create a 6-month transition roadmap.",
    "What skills should a [role] have in 2025? Rank by importance and suggest resources.",
    "Write a LinkedIn connection request message to a [role] at [company type] for networking.",
    "I'm a [student] interested in [field]. What projects make my GitHub portfolio stand out?",
    "Compare careers in [field A] vs [field B] — salary, growth, day-to-day, required skills.",
    "What certifications are genuinely valuable for a career in [field] in 2025?",
    "Draft a cold email to a startup founder for an internship in [field]. Keep it under 150 words.",
    "What are the unwritten rules of working in tech that nobody mentions in school?",
    "I have [skill set]. What job roles can I apply for? List 5 with brief descriptions.",
    "How do I build a personal brand as a [role] on LinkedIn? Give me a 30-day content calendar.",
    "What questions should I ask in an informational interview with a [role] at [company]?",
    "Create a 90-day plan for someone who just started their first tech internship.",
  ],
  "Creative Writing": [
    "Write a 500-word sci-fi story set in a world where AI has replaced all repetitive jobs.",
    "Help me brainstorm 10 unique plot ideas for a tech thriller involving a rogue AI system.",
    "Write the opening paragraph of a blog post about [topic] in a conversational, engaging tone.",
    "Create a compelling product description for [product idea] targeting college students.",
    "Write a creative 'About Me' section for my portfolio website. I'm a [student] who loves [interests].",
    "Generate 5 catchy headline options for a blog post about [topic] — vary the styles.",
    "Write a Twitter thread (8 tweets) explaining [complex tech concept] simply and engagingly.",
    "Create a metaphor that explains [technical concept] to a non-technical audience.",
    "Write a compelling GitHub README for my [project name]: [brief description of what it does]",
    "Write a project description for [project] to include on my LinkedIn profile. Max 3 sentences.",
    "Help me write a personal statement for a [program/scholarship] application. My background: [info]",
    "Create an engaging elevator pitch for my [project/startup idea] in under 60 seconds.",
  ],
};

// ── Career Data ──────────────────────────────────────────────────────────────
const CAREERS = [
  {
    id:'ai-ml', icon:'🤖', title:'AI/ML Engineer', color:'#6366f1',
    overview:'Design, build, and deploy machine learning models and AI systems at production scale. Work at the intersection of research and engineering.',
    skills:['Python','TensorFlow / PyTorch','Scikit-learn','Linear Algebra & Statistics','Feature Engineering','MLOps & CI/CD','SQL & Data Pipelines','Cloud Platforms (AWS/GCP)'],
    path:['Python fundamentals & OOP','Math: Linear Algebra, Calculus, Probability','ML with Scikit-learn (regression to ensembles)','Deep Learning (TensorFlow or PyTorch)','Specialization: NLP or Computer Vision','MLOps: Docker, model serving, monitoring','Build 3+ end-to-end portfolio projects'],
    resources:['fast.ai','deeplearning.ai','Kaggle','Papers with Code','Hugging Face Hub'],
    opportunities:['ML Engineer at AI startups','Research Scientist','MLOps Engineer','Computer Vision Engineer','NLP Engineer'],
    salary:'₹8–25 LPA (India) | $100K–$180K (US)',
  },
  {
    id:'data', icon:'📊', title:'Data Scientist', color:'#22d3ee',
    overview:'Extract actionable insights from complex datasets using statistics, ML, and visualization. Bridge the gap between data and business decisions.',
    skills:['Python or R','Pandas, NumPy, Matplotlib','SQL & Database Design','Statistical Testing & A/B Testing','Machine Learning','Tableau / Power BI','Data Storytelling','Feature Engineering'],
    path:['Statistics & probability fundamentals','Python data analysis (Pandas, NumPy)','SQL — queries, joins, aggregations','Data visualization (Matplotlib, Seaborn, Tableau)','Machine learning basics to advanced','Business analytics & communication','Portfolio with 3+ real-world analyses'],
    resources:['Kaggle','DataCamp','Mode Analytics','Towards Data Science','Google Data Analytics Cert'],
    opportunities:['Data Scientist','Business Analyst','Product Analyst','ML Engineer','Data Engineer'],
    salary:'₹6–20 LPA (India) | $90K–$160K (US)',
  },
  {
    id:'web', icon:'🌐', title:'Web Developer', color:'#a855f7',
    overview:'Build the websites and web applications that power the modern internet. Specializations in frontend, backend, or full-stack development.',
    skills:['HTML5, CSS3, JavaScript (ES6+)','React.js or Vue.js','Node.js + Express','PostgreSQL / MongoDB','REST APIs & GraphQL','Git & GitHub','Responsive Design','Deployment (Vercel, AWS)'],
    path:['HTML & CSS fundamentals','JavaScript — DOM, async, ES6+','Frontend framework (React recommended)','Backend: Node.js + Express or Django','Databases: PostgreSQL + MongoDB basics','Authentication (JWT, OAuth)','Build and deploy 4+ full-stack projects'],
    resources:['The Odin Project','freeCodeCamp','MDN Web Docs','Frontend Masters','JavaScript.info'],
    opportunities:['Frontend Developer','Full Stack Developer','React Specialist','Backend Engineer','DevRel Engineer'],
    salary:'₹5–18 LPA (India) | $80K–$150K (US)',
  },
  {
    id:'cyber', icon:'🔒', title:'Cybersecurity Analyst', color:'#f59e0b',
    overview:'Protect organizations from cyber threats, breaches, and attacks. Monitor networks, respond to incidents, and build security systems.',
    skills:['Networking (TCP/IP, DNS, HTTP)','Linux & Windows Administration','Ethical Hacking & Penetration Testing','SIEM Tools','Python & Bash Scripting','Cryptography Basics','Incident Response','OWASP Top 10'],
    path:['Networking fundamentals (CompTIA Network+)','Linux command line proficiency','CompTIA Security+ certification','Ethical hacking with TryHackMe','Web application security (OWASP)','Penetration testing labs (Hack The Box)','Specialize: Cloud Security, AppSec, or SOC'],
    resources:['TryHackMe','Hack The Box','OWASP','Cybrary','Professor Messer'],
    opportunities:['SOC Analyst','Penetration Tester','Security Engineer','Cloud Security Specialist','Bug Bounty Hunter'],
    salary:'₹5–22 LPA (India) | $85K–$165K (US)',
  },
  {
    id:'uiux', icon:'🎨', title:'UI/UX Designer', color:'#ec4899',
    overview:'Create intuitive, beautiful digital experiences. Research users, design interfaces, prototype interactions, and collaborate with engineers.',
    skills:['Figma (advanced)','Design Systems & Components','Wireframing & Prototyping','User Research Methods','Usability Testing','Visual Design Principles','UX Writing','HTML/CSS basics'],
    path:['Design fundamentals: color, typography, hierarchy','Learn Figma end-to-end','Wireframing & prototyping techniques','User research & persona creation','Design systems','Build a portfolio of 4–6 case studies','HTML/CSS for developer collaboration'],
    resources:['Google UX Design Certificate','Figma Community','Nielsen Norman Group','Awwwards','Dribbble'],
    opportunities:['UI/UX Designer','Product Designer','UX Researcher','Design Systems Engineer','Interaction Designer'],
    salary:'₹5–18 LPA (India) | $80K–$140K (US)',
  },
  {
    id:'cloud', icon:'☁️', title:'Cloud Engineer', color:'#06b6d4',
    overview:'Design and manage scalable cloud infrastructure. Enable organizations to leverage reliable, cost-efficient computing on AWS, Azure, or GCP.',
    skills:['AWS / Azure / GCP core services','Linux & Command Line','Terraform & IaC','Docker & Kubernetes','CI/CD Pipelines','Networking & Security','Python / Bash scripting','Monitoring & Observability'],
    path:['Linux & networking fundamentals','AWS Cloud Practitioner certification','Core AWS services deep dive','Infrastructure as Code with Terraform','Docker containerization','Kubernetes orchestration','Solutions Architect certification'],
    resources:['AWS Training','A Cloud Guru','Linux Foundation','KodeKloud','Cloud Resume Challenge'],
    opportunities:['Cloud Engineer','DevOps Engineer','Site Reliability Engineer','Platform Engineer','Cloud Architect'],
    salary:'₹8–28 LPA (India) | $110K–$190K (US)',
  },
  {
    id:'pm', icon:'📋', title:'Product Manager', color:'#84cc16',
    overview:'Define product vision, strategy, and roadmap. Bridge engineering, design, and business to decide what gets built, when, and why.',
    skills:['Product Strategy & Roadmapping','User Research & Interviews','Data Analysis & A/B Testing','Agile / Scrum / Kanban','Wireframing in Figma','SQL basics','Stakeholder Communication','Prioritization Frameworks (RICE, ICE)'],
    path:['Agile & Scrum fundamentals','Product management study (Lenny\'s Newsletter, Reforge)','SQL & analytics basics','Wireframing skills in Figma','Build product case studies portfolio','APM internship or associate PM role','PSPO or Product School certification'],
    resources:["Lenny's Newsletter",'Reforge Blog','Product School','Mind the Product','Intercom on Product Management'],
    opportunities:['Associate PM','Product Manager','Technical PM','Growth PM','Product Analyst'],
    salary:'₹10–35 LPA (India) | $120K–$220K (US)',
  },
  {
    id:'research', icon:'🔬', title:'AI Researcher', color:'#8b5cf6',
    overview:'Advance the frontiers of AI through original research. Develop new algorithms, architectures, and frameworks that push AI capabilities forward.',
    skills:['Advanced Mathematics (all of it)','Python & JAX / PyTorch (deep)','Scientific Computing & Statistics','Research Paper Writing','Literature Review Skills','Experimental Design','LaTeX','ML System Design'],
    path:['Rigorous math foundation (MIT OCW)','Master Python + PyTorch deeply','Read 50+ foundational ML papers','Implement research papers from scratch','Contribute to open-source ML projects','Work under a professor or research lab','Publish or co-author a paper'],
    resources:['arXiv','Papers with Code','Deep Learning Book (Goodfellow)','Distill.pub','fast.ai Research'],
    opportunities:['Research Scientist at AI Lab','PhD in AI/ML','Applied Research Scientist','AI Safety Researcher','ML Research Engineer'],
    salary:'₹15–60 LPA (India) | $150K–$400K+ (US)',
  },
];

// ── Projects Data ─────────────────────────────────────────────────────────────
const PROJECTS = [
  // AI
  {id:'p1',title:'AI Chatbot with Personality',cat:'AI',diff:'Beginner',desc:'Build an API-powered chatbot with a distinct character and domain expertise. Great intro to prompt engineering and conversational UI design.',tech:['Python','OpenAI API','Flask','HTML/CSS']},
  {id:'p2',title:'Image Caption Generator',cat:'AI',diff:'Intermediate',desc:'Use a pre-trained vision-language model to auto-generate descriptive captions for uploaded images. Deploy as a web app.',tech:['Python','Hugging Face','Gradio','Transformers']},
  {id:'p3',title:'AI Resume Analyzer',cat:'AI',diff:'Intermediate',desc:'Parse a resume PDF, score it on ATS criteria, extract keywords, and suggest specific improvements using NLP.',tech:['Python','spaCy','FastAPI','React']},
  {id:'p4',title:'Fine-Tuned LLM for Q&A',cat:'AI',diff:'Advanced',desc:'Fine-tune an open-source LLM on a custom domain dataset to answer specialized questions accurately.',tech:['Python','PyTorch','LoRA','Hugging Face']},
  {id:'p5',title:'Prompt Optimizer Tool',cat:'AI',diff:'Intermediate',desc:'Input a basic idea and get optimized, structured prompts for image generation and language models.',tech:['Python','OpenAI API','Streamlit','Redis']},
  // Python
  {id:'p6',title:'Personal Finance Tracker',cat:'Python',diff:'Beginner',desc:'CLI app to track income, expenses, and savings with CSV export, categories, and basic monthly analytics.',tech:['Python','Pandas','Rich','CSV']},
  {id:'p7',title:'Web Scraper Dashboard',cat:'Python',diff:'Intermediate',desc:'Scrape job listings, news, or product prices and display them in an interactive dashboard.',tech:['Python','BeautifulSoup','Streamlit','SQLite']},
  {id:'p8',title:'Automated Report Generator',cat:'Python',diff:'Intermediate',desc:'Compile data from multiple sources and auto-generate formatted PDF/email reports on a schedule.',tech:['Python','Pandas','ReportLab','Schedule']},
  {id:'p9',title:'Discord Bot with AI Features',cat:'Python',diff:'Intermediate',desc:'A Discord bot that answers questions, generates images, helps with code, or moderates servers.',tech:['Python','discord.py','OpenAI API','SQLite']},
  {id:'p10',title:'GitHub Profile Analyzer',cat:'Python',diff:'Beginner',desc:'Analyze any GitHub profile using the GitHub API — show repos, languages, commit patterns, and activity.',tech:['Python','GitHub API','Matplotlib','Rich']},
  // Machine Learning
  {id:'p11',title:'Spam Email Classifier',cat:'Machine Learning',diff:'Beginner',desc:'Train a Naive Bayes or SVM classifier to detect spam emails. A classic entry-point ML project.',tech:['Python','Scikit-learn','NLTK','Pandas']},
  {id:'p12',title:'Sentiment Analysis API',cat:'Machine Learning',diff:'Intermediate',desc:'Build and deploy a REST API that classifies text sentiment using a fine-tuned BERT model.',tech:['Python','BERT','FastAPI','Docker']},
  {id:'p13',title:'Movie Recommendation Engine',cat:'Machine Learning',diff:'Intermediate',desc:'Collaborative filtering recommendation system using the MovieLens dataset.',tech:['Python','Scikit-learn','Surprise','Flask']},
  {id:'p14',title:'Fraud Detection System',cat:'Machine Learning',diff:'Advanced',desc:'End-to-end pipeline for detecting fraudulent credit card transactions with imbalanced learning.',tech:['Python','XGBoost','SMOTE','MLflow','FastAPI']},
  {id:'p15',title:'Real-Time Emotion Detector',cat:'Machine Learning',diff:'Advanced',desc:'Use a CNN to detect and classify facial emotions from live webcam feed in real time.',tech:['Python','TensorFlow','OpenCV','Flask']},
  // Data Science
  {id:'p16',title:'COVID-19 Data Analysis',cat:'Data Science',diff:'Beginner',desc:'EDA on global COVID-19 datasets with visualizations showing trends, correlations, and geographic patterns.',tech:['Python','Pandas','Plotly','Jupyter']},
  {id:'p17',title:'Sales Forecasting Dashboard',cat:'Data Science',diff:'Intermediate',desc:'Time series forecasting (Prophet/ARIMA) with an interactive Plotly dashboard for business stakeholders.',tech:['Python','Prophet','Plotly Dash','PostgreSQL']},
  {id:'p18',title:'Student Performance Predictor',cat:'Data Science',diff:'Beginner',desc:'Analyze factors affecting student grades and build a simple ML model to predict and visualize performance.',tech:['Python','Pandas','Seaborn','Scikit-learn']},
  {id:'p19',title:'A/B Test Results Analyzer',cat:'Data Science',diff:'Intermediate',desc:'Tool that accepts raw A/B test data and outputs statistical significance, confidence intervals, and a recommendation.',tech:['Python','SciPy','Streamlit','NumPy']},
  {id:'p20',title:'Self-Service BI Dashboard',cat:'Data Science',diff:'Advanced',desc:'Full analytics dashboard where users upload any CSV and get instant charts, correlations, and summaries.',tech:['Python','Dash','Plotly','Pandas','Redis']},
  // Web Development
  {id:'p21',title:'Personal Portfolio Website',cat:'Web Development',diff:'Beginner',desc:'Clean, responsive portfolio with project showcase, about section, skills, and contact form. Deploy on Netlify.',tech:['HTML','CSS','JavaScript','Netlify']},
  {id:'p22',title:'Real-Time Chat App',cat:'Web Development',diff:'Intermediate',desc:'WebSocket-powered chat with rooms, user authentication, typing indicators, and message history.',tech:['Node.js','Socket.io','React','MongoDB']},
  {id:'p23',title:'Internship Tracker Dashboard',cat:'Web Development',diff:'Intermediate',desc:'Kanban board to track job applications with status columns, notes, deadlines, and reminder emails.',tech:['React','Node.js','PostgreSQL','Nodemailer']},
  {id:'p24',title:'Full-Stack SaaS Platform',cat:'Web Development',diff:'Advanced',desc:'Complete SaaS with user auth, subscription billing, dashboard, REST API, and admin panel.',tech:['Next.js','Node.js','Stripe','PostgreSQL','Redis']},
  {id:'p25',title:'Full-Stack Blog Platform',cat:'Web Development',diff:'Intermediate',desc:'Blog with markdown editor, user auth, tags, search, comments, and a full admin dashboard.',tech:['React','Node.js','MongoDB','Express']},
];

// ── Roadmap Data ──────────────────────────────────────────────────────────────
const ROADMAPS = {
  'Artificial Intelligence': {
    beginner:  { topics:['Python 3 fundamentals (OOP, data structures)','Mathematics: Linear Algebra & Statistics basics','Introduction to AI concepts and history','Jupyter Notebook & data exploration','Build: calculator, number guesser, data viz app'], duration:'2-3 months' },
    intermediate: { topics:['Machine Learning with Scikit-learn (regression, classification, clustering)','Feature engineering & preprocessing','Model evaluation metrics & cross-validation','Intro to Deep Learning (TensorFlow or PyTorch)','Build: price predictor, spam classifier, image classifier'], duration:'3-4 months' },
    advanced:  { topics:['Deep Learning architectures (CNNs, RNNs, Transformers)','NLP: from bag-of-words to BERT fine-tuning','Computer Vision with OpenCV + CNNs','MLOps: Docker, model serving, monitoring','Build: NLP API, real-time vision app, fine-tuned LLM'], duration:'4-6 months' },
    tools:['Python 3','Jupyter / Colab','TensorFlow','PyTorch','Scikit-learn','Pandas','NumPy','Hugging Face','MLflow'],
    certs:['Google ML Crash Course','DeepLearning.AI TF Developer','fast.ai Practical Deep Learning','AWS ML Specialty'],
  },
  'Web Development': {
    beginner:  { topics:['HTML5 — semantics, forms, accessibility','CSS3 — Flexbox, Grid, responsive design','JavaScript — variables, DOM, events, fetch API','Git & GitHub basics','Build: portfolio site, product landing page, quiz app'], duration:'2-3 months' },
    intermediate: { topics:['React.js — components, hooks, state management','Node.js + Express — REST API development','PostgreSQL or MongoDB — database fundamentals','Authentication with JWT + bcrypt','Build: full-stack todo app, weather dashboard, blog'], duration:'3-4 months' },
    advanced:  { topics:['TypeScript for type safety','Next.js — SSR, SSG, App Router','Advanced React patterns + performance optimization','CI/CD with GitHub Actions','Build: e-commerce platform, real-time app, SaaS dashboard'], duration:'3-4 months' },
    tools:['VS Code','Git','React','Node.js','PostgreSQL','MongoDB','Vercel','Postman','Docker'],
    certs:['freeCodeCamp Responsive Web Design','Meta Front-End Developer','AWS Cloud Practitioner'],
  },
  'Data Science': {
    beginner:  { topics:['Python for data analysis (Pandas, NumPy)','Statistics: distributions, correlation, hypothesis testing','Data cleaning & preprocessing techniques','Basic visualization: Matplotlib, Seaborn','SQL fundamentals for data analysts'], duration:'2-3 months' },
    intermediate: { topics:['Advanced SQL & window functions','ML with Scikit-learn: regression to ensembles','Feature engineering & selection','A/B testing & statistical significance','Tableau or Power BI for BI dashboards'], duration:'3-4 months' },
    advanced:  { topics:['Advanced ML: XGBoost, LightGBM, stacking','Time series analysis & forecasting','Big data basics (Spark introduction)','Data storytelling & stakeholder communication','Build end-to-end data products'], duration:'4-5 months' },
    tools:['Python','Jupyter','Pandas','Seaborn','Tableau','Power BI','SQL','Scikit-learn','Spark'],
    certs:['Google Data Analytics Certificate','IBM Data Science Professional','DataCamp Data Scientist'],
  },
  'Machine Learning': {
    beginner:  { topics:['Python + NumPy + Pandas foundation','Statistics: probability, Bayes theorem, distributions','ML concepts: supervised vs unsupervised vs RL','Linear & logistic regression from scratch','Evaluation: accuracy, precision, recall, F1, ROC'], duration:'2-3 months' },
    intermediate: { topics:['Decision Trees, Random Forests, Gradient Boosting','SVM, K-Means, PCA','Cross-validation & hyperparameter tuning (GridSearch)','Neural network fundamentals (MLP)','Build: fraud detector, sentiment classifier, recommender'], duration:'3-4 months' },
    advanced:  { topics:['Deep Learning: CNNs, RNNs, Transformers','Transfer learning & fine-tuning','MLOps: Docker, FastAPI, MLflow, CI/CD','Deploy models to production (AWS/GCP)','Research paper reading & implementation'], duration:'4-6 months' },
    tools:['Python','Scikit-learn','TensorFlow','PyTorch','XGBoost','MLflow','DVC','Weights & Biases'],
    certs:['DeepLearning.AI ML Specialization','fast.ai Practical DL','TensorFlow Developer Certificate'],
  },
  'Cybersecurity': {
    beginner:  { topics:['Networking: IP, TCP/IP, DNS, HTTP, subnetting','Linux command line mastery','How the internet works (protocols, architecture)','Cybersecurity concepts: CIA triad, common threats','Set up a virtual lab with Kali Linux'], duration:'2-3 months' },
    intermediate: { topics:['CompTIA Security+ exam preparation','Ethical hacking fundamentals (Kali, Metasploit)','Web app security: OWASP Top 10','Vulnerability scanning (Nmap, Nessus)','TryHackMe guided learning paths'], duration:'3-4 months' },
    advanced:  { topics:['Advanced penetration testing (OSCP prep)','Cloud security (AWS Security Specialty)','Malware analysis & reverse engineering','Security automation with Python','Bug bounty hunting methodology & reporting'], duration:'5-7 months' },
    tools:['Kali Linux','Wireshark','Metasploit','Burp Suite','Nmap','TryHackMe','Hack The Box','Ghidra'],
    certs:['CompTIA Security+','CEH (Certified Ethical Hacker)','OSCP','Google Cybersecurity Certificate'],
  },
  'UI/UX Design': {
    beginner:  { topics:['Design principles: color theory, typography, spacing, hierarchy','Introduction to Figma — components, auto-layout, styles','Wireframing techniques — low to high fidelity','Basic user research: surveys, interviews, personas','Accessibility fundamentals (WCAG 2.1)'], duration:'2 months' },
    intermediate: { topics:['Interactive prototyping in Figma','Design systems and component libraries','Usability testing & iterating on feedback','UX writing & microcopy best practices','HTML/CSS basics for designer-dev collaboration'], duration:'2-3 months' },
    advanced:  { topics:['Advanced motion design & micro-interactions','Cross-platform design (iOS, Android, web, tablet)','UX research methodologies (diary studies, tree testing)','Design metrics & measuring UX success','Full product design case studies with outcomes'], duration:'3-4 months' },
    tools:['Figma','FigJam','Maze','Lottie Files','Framer','Miro','Adobe Illustrator','Zeroheight'],
    certs:['Google UX Design Certificate','Interaction Design Foundation','Figma Professional'],
  },
};

// ── AI Tools Data ────────────────────────────────────────────────────────────
const AI_TOOLS = [
  {name:'ChatGPT',cat:'Writing',icon:'💬',desc:"OpenAI's flagship conversational AI. Excellent for writing, editing, brainstorming, summarization, and drafting.",use:'Blog posts, emails, reports, creative writing, code explanations.',best:'General-purpose writing assistance for all skill levels.'},
  {name:'Claude',cat:'Writing',icon:'✦',desc:"Anthropic's AI known for thoughtful, nuanced writing, document analysis, and strong instruction-following.",use:'Long-form writing, analysis, research summaries, document review.',best:'Complex writing tasks needing careful reasoning and nuance.'},
  {name:'Grammarly',cat:'Writing',icon:'✏️',desc:'AI-powered grammar checker, style editor, tone detector, and plagiarism checker.',use:'Proofreading emails, essays, professional documents, LinkedIn posts.',best:'Anyone writing professionally who wants polished, error-free output.'},
  {name:'Jasper AI',cat:'Writing',icon:'🖊️',desc:'Marketing-focused AI writing platform for blogs, ads, social content, and brand copy.',use:'Marketing copy, blog posts, email campaigns, product descriptions.',best:'Marketers and content creators needing on-brand content at scale.'},
  {name:'GitHub Copilot',cat:'Coding',icon:'⌗',desc:'AI pair programmer that suggests code completions, functions, and docs inside your editor.',use:'Autocomplete, boilerplate generation, test writing, documentation.',best:'All developers — especially for repetitive coding tasks and new languages.'},
  {name:'Cursor',cat:'Coding',icon:'⚡',desc:'AI-first code editor (VS Code fork) that can write, edit, and explain entire codebases contextually.',use:'Building features, refactoring, debugging, and code generation.',best:'Developers wanting deep AI integration in their workflow.'},
  {name:'Replit AI',cat:'Coding',icon:'🔄',desc:'Browser-based IDE with AI that can build, run, explain, and deploy code instantly.',use:'Learning to code, quick prototyping, sharing projects with a URL.',best:'Students and beginners learning to code without setup friction.'},
  {name:'Tabnine',cat:'Coding',icon:'🔷',desc:'AI code completion with on-premise options for teams with privacy requirements.',use:'Code completion and review across all major languages and editors.',best:'Teams needing AI coding assistance with data privacy controls.'},
  {name:'Perplexity AI',cat:'Research',icon:'🔍',desc:'AI search engine that answers questions with cited, real-time web sources.',use:'Research, fact-checking, understanding complex topics quickly.',best:'Students and researchers who need sourced, up-to-date answers.'},
  {name:'Elicit',cat:'Research',icon:'📑',desc:'AI research assistant for finding, summarizing, and comparing academic papers.',use:'Literature reviews, academic research, paper summaries and extraction.',best:'Students and researchers doing systematic literature reviews.'},
  {name:'NotebookLM',cat:'Research',icon:'📓',desc:"Google's AI notebook that answers questions from your own uploaded documents.",use:'Studying from PDFs, research papers, textbooks, and meeting notes.',best:"Students who want to 'chat' with their own study materials."},
  {name:'Consensus',cat:'Research',icon:'🎯',desc:'AI search engine for finding scientific evidence and peer-reviewed answers.',use:'Evidence-based research, verifying health and science claims.',best:'Anyone needing peer-reviewed evidence for papers or decisions.'},
  {name:'Midjourney',cat:'Design',icon:'🎨',desc:'Powerful AI image generation model known for stunning, artistic visual output.',use:'Concept art, illustrations, marketing visuals, mood boards, UI inspiration.',best:'Designers and creators who need high-quality AI-generated visuals.'},
  {name:'Figma AI',cat:'Design',icon:'◈',desc:'AI features natively in Figma: auto-layout, component suggestions, design generation.',use:'UI design, wireframing, prototyping, design system management.',best:'UI/UX designers wanting AI woven into their existing Figma workflow.'},
  {name:'Canva AI',cat:'Design',icon:'🖌️',desc:'AI-powered design platform with text-to-image, magic resize, and content suggestions.',use:'Presentations, social graphics, posters, resumes, and infographics.',best:'Non-designers who need professional visuals quickly and easily.'},
  {name:'DALL·E 3',cat:'Design',icon:'🌈',desc:"OpenAI's image generation model with strong prompt-following and text rendering in images.",use:'Generating precise images from text descriptions for any use case.',best:'Developers integrating AI image generation into applications.'},
  {name:'Notion AI',cat:'Productivity',icon:'📒',desc:'AI embedded in Notion for summarizing, writing, translating, and organizing notes.',use:'Note-taking, project docs, meeting summaries, writing first drafts.',best:'Students and teams using Notion as their central workspace.'},
  {name:'Otter.ai',cat:'Productivity',icon:'🎙️',desc:'Real-time AI transcription and meeting notes with speaker identification.',use:'Recording lectures, meetings, interviews, and creating searchable transcripts.',best:'Students attending lectures and professionals in back-to-back meetings.'},
  {name:'Motion',cat:'Productivity',icon:'📅',desc:'AI calendar and task manager that automatically schedules your work into open time slots.',use:'Task prioritization, schedule blocking, deadline management.',best:'Busy people who over-commit and need AI to manage their time.'},
  {name:'Mem.ai',cat:'Productivity',icon:'🧠',desc:'AI notes app that automatically surfaces relevant notes when you need them.',use:'Knowledge management, linking ideas, personal wikis, meeting notes.',best:'People who take lots of notes and want AI to make connections.'},
  {name:'Khan Academy Khanmigo',cat:'Education',icon:'🎓',desc:"AI Socratic tutor inside Khan Academy that guides students through problems step-by-step.",use:'Math, science, coding, humanities with personalized Socratic guidance.',best:'K-12 and college students needing patient, guided tutoring.'},
  {name:'Photomath',cat:'Education',icon:'📐',desc:'Solves math problems from a photo with detailed step-by-step solutions.',use:'Understanding how to solve any math problem from arithmetic to calculus.',best:'Students who struggle with math and need clear explanations.'},
  {name:'Wolfram Alpha',cat:'Education',icon:'∑',desc:'Computational knowledge engine for math, science, finance, and factual queries.',use:'Complex math, physics, chemistry, statistics, and unit conversions.',best:'STEM students who need precise computations and verified results.'},
  {name:'Duolingo Max',cat:'Education',icon:'🦉',desc:'Language learning app with AI roleplay conversations and explanation features.',use:'Learning a new language with AI-powered speaking and writing practice.',best:'Language learners wanting personalized, gamified daily practice.'},
];

// ── Blog Data ────────────────────────────────────────────────────────────────
const BLOGS = [
  {id:'b1',emoji:'🛠️',title:'Best AI Tools for Students in 2025',author:'NeuraPath Team',date:'December 2025',cat:'AI Tools',readTime:'8 min read',summary:'A comprehensive, honest guide to the most valuable AI tools for students in 2025 — covering writing assistants, research tools, coding helpers, design tools, and productivity apps. We separate the genuinely useful from the overhyped.',content:'The AI tools landscape has exploded. For students, the challenge isn\'t finding AI tools — it\'s knowing which ones actually help you learn better, build faster, and work smarter...'},
  {id:'b2',emoji:'🧠',title:'How to Learn AI from Scratch: A Complete Beginner\'s Guide',author:'NeuraPath Team',date:'December 2025',cat:'Learning',readTime:'12 min read',summary:'Starting from zero? This guide walks you through exactly how to begin your AI learning journey — no PhD required. Covers free resources, realistic timelines, essential math, first projects, and how to stay consistent.',content:'Artificial intelligence feels intimidating when you\'re starting from scratch. The terminology is dense, the math looks scary, and the field moves so fast...'},
  {id:'b3',emoji:'💼',title:'Building Your First Tech Portfolio: What Actually Works',author:'NeuraPath Team',date:'November 2025',cat:'Career',readTime:'10 min read',summary:'A portfolio is your proof of work. This guide explains exactly what projects to build, how to present them on GitHub and LinkedIn, and what hiring managers actually look for when reviewing a student\'s portfolio.',content:'Most students build portfolios that get ignored. Not because the projects are bad — but because they\'re presented poorly, lack context, and don\'t tell a story...'},
  {id:'b4',emoji:'🎓',title:'How to Get Your First Tech Internship: The Complete Playbook',author:'NeuraPath Team',date:'November 2025',cat:'Career',readTime:'15 min read',summary:'From polishing your resume to acing the technical interview — this step-by-step playbook covers everything you need to land your first tech internship, even without prior experience or a brand-name college.',content:'Landing your first tech internship is the hardest one. After that, each one gets easier. Here\'s the honest, practical playbook...'},
  {id:'b5',emoji:'🚀',title:'Future Careers in AI: What\'s Coming and How to Prepare',author:'NeuraPath Team',date:'November 2025',cat:'AI & Future',readTime:'9 min read',summary:'The AI job market is evolving at unprecedented speed. This article explores which roles are emerging, what skills will matter most in the next 5 years, and how students today can position themselves for tomorrow\'s careers.',content:'The AI revolution isn\'t coming — it\'s already here. By 2027, analysts predict AI will have touched virtually every industry...'},
  {id:'b6',emoji:'✨',title:'Prompt Engineering Basics: A Practical Introduction',author:'NeuraPath Team',date:'October 2025',cat:'Prompt Engineering',readTime:'7 min read',summary:'Prompt engineering is rapidly becoming a fundamental skill for anyone who uses AI tools. Learn the core principles, proven techniques like chain-of-thought and few-shot prompting, and practical examples you can use today.',content:'You don\'t need to train a model to be a prompt engineer. The skill is about communicating clearly and strategically with AI systems...'},
];

// ═══════════════════════════════════════════════════════════════════════════════
// HTTP SERVER
// ═══════════════════════════════════════════════════════════════════════════════

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin':'*',
      'Access-Control-Allow-Methods':'GET,POST,PUT,DELETE,OPTIONS',
      'Access-Control-Allow-Headers':'Content-Type',
    });
    return res.end();
  }

  // ── API ROUTES ──────────────────────────────────────────────────────────────

  // GET /api/health
  if (pathname === '/api/health' && req.method === 'GET') {
    return sendJSON(res, 200, { status:'ok', version:'1.0.0', platform:'NeuraPath AI', timestamp: new Date().toISOString() });
  }

  // POST /api/noir/chat
  if (pathname === '/api/noir/chat' && req.method === 'POST') {
    const body = await readBody(req);
    const { message, sessionId } = body;
    if (!message || !message.trim()) return sendJSON(res, 400, { error:'Message is required' });

    const reply = getNoirReply(message.trim());
    const entry = { id: crypto.randomUUID(), sessionId: sessionId || 'anon', message: message.trim(), reply, timestamp: new Date().toISOString() };

    const history = readJSON(FILES.chatHistory);
    history.push(entry);
    if (history.length > 500) history.splice(0, history.length - 500);
    writeJSON(FILES.chatHistory, history);

    return sendJSON(res, 200, { reply, id: entry.id, timestamp: entry.timestamp });
  }

  // GET /api/prompts  ?category=&search=
  if (pathname === '/api/prompts' && req.method === 'GET') {
    const { category, search } = parsed.query;
    let result = {};
    for (const [cat, list] of Object.entries(PROMPTS)) {
      if (category && category !== 'All' && cat !== category) continue;
      let filtered = list;
      if (search) filtered = list.filter(p => p.toLowerCase().includes(search.toLowerCase()));
      if (filtered.length) result[cat] = filtered;
    }
    return sendJSON(res, 200, { prompts: result, categories: Object.keys(PROMPTS) });
  }

  // POST /api/prompts/save
  if (pathname === '/api/prompts/save' && req.method === 'POST') {
    const body = await readBody(req);
    const { sessionId, prompt, category } = body;
    if (!prompt) return sendJSON(res, 400, { error:'Prompt text required' });
    const saved = readJSON(FILES.savedPrompts);
    const key = sessionId || 'anon';
    if (!saved[key]) saved[key] = [];
    const already = saved[key].find(p => p.prompt === prompt);
    if (already) return sendJSON(res, 200, { message:'Already saved', saved: saved[key] });
    saved[key].push({ id: crypto.randomUUID(), prompt, category, savedAt: new Date().toISOString() });
    writeJSON(FILES.savedPrompts, saved);
    return sendJSON(res, 200, { message:'Prompt saved!', saved: saved[key] });
  }

  // GET /api/prompts/saved?sessionId=
  if (pathname === '/api/prompts/saved' && req.method === 'GET') {
    const { sessionId } = parsed.query;
    const saved = readJSON(FILES.savedPrompts);
    return sendJSON(res, 200, { saved: saved[sessionId || 'anon'] || [] });
  }

  // DELETE /api/prompts/saved
  if (pathname === '/api/prompts/saved' && req.method === 'DELETE') {
    const body = await readBody(req);
    const { sessionId, promptId } = body;
    const saved = readJSON(FILES.savedPrompts);
    const key = sessionId || 'anon';
    if (saved[key]) saved[key] = saved[key].filter(p => p.id !== promptId);
    writeJSON(FILES.savedPrompts, saved);
    return sendJSON(res, 200, { message:'Prompt removed', saved: saved[key] || [] });
  }

  // GET /api/careers  ?id=
  if (pathname === '/api/careers' && req.method === 'GET') {
    const { id } = parsed.query;
    if (id) {
      const career = CAREERS.find(c => c.id === id);
      return career ? sendJSON(res, 200, career) : sendJSON(res, 404, { error:'Career not found' });
    }
    return sendJSON(res, 200, { careers: CAREERS });
  }

  // GET /api/projects  ?cat=&diff=&search=
  if (pathname === '/api/projects' && req.method === 'GET') {
    const { cat, diff, search } = parsed.query;
    let filtered = [...PROJECTS];
    if (cat && cat !== 'All') filtered = filtered.filter(p => p.cat === cat);
    if (diff && diff !== 'All') filtered = filtered.filter(p => p.diff === diff);
    if (search) filtered = filtered.filter(p => p.title.toLowerCase().includes(search.toLowerCase()) || p.desc.toLowerCase().includes(search.toLowerCase()));
    const cats = ['All', ...new Set(PROJECTS.map(p => p.cat))];
    const diffs = ['All', 'Beginner', 'Intermediate', 'Advanced'];
    return sendJSON(res, 200, { projects: filtered, categories: cats, difficulties: diffs, total: filtered.length });
  }

  // GET /api/roadmaps  ?topic=
  if (pathname === '/api/roadmaps' && req.method === 'GET') {
    const { topic } = parsed.query;
    if (topic && ROADMAPS[topic]) return sendJSON(res, 200, { topic, roadmap: ROADMAPS[topic] });
    return sendJSON(res, 200, { roadmaps: ROADMAPS, topics: Object.keys(ROADMAPS) });
  }

  // GET /api/tools  ?cat=
  if (pathname === '/api/tools' && req.method === 'GET') {
    const { cat } = parsed.query;
    let filtered = cat && cat !== 'All' ? AI_TOOLS.filter(t => t.cat === cat) : [...AI_TOOLS];
    const cats = ['All', ...new Set(AI_TOOLS.map(t => t.cat))];
    return sendJSON(res, 200, { tools: filtered, categories: cats });
  }

  // GET /api/blog  ?id=
  if (pathname === '/api/blog' && req.method === 'GET') {
    const { id } = parsed.query;
    if (id) {
      const post = BLOGS.find(b => b.id === id);
      return post ? sendJSON(res, 200, post) : sendJSON(res, 404, { error:'Post not found' });
    }
    return sendJSON(res, 200, { posts: BLOGS });
  }

  // POST /api/contact
  if (pathname === '/api/contact' && req.method === 'POST') {
    const body = await readBody(req);
    const { name, email, subject, message } = body;
    if (!name || !email || !message) return sendJSON(res, 400, { error:'Name, email, and message are required' });
    const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRe.test(email)) return sendJSON(res, 400, { error:'Invalid email address' });

    const contacts = readJSON(FILES.contacts);
    contacts.push({ id: crypto.randomUUID(), name, email, subject: subject || 'General Inquiry', message, submittedAt: new Date().toISOString(), status:'unread' });
    writeJSON(FILES.contacts, contacts);

    return sendJSON(res, 200, { success:true, message:`Thanks ${name}! We received your message and will reply to ${email} shortly.` });
  }

  // POST /api/subscribe
  if (pathname === '/api/subscribe' && req.method === 'POST') {
    const body = await readBody(req);
    const { email } = body;
    if (!email) return sendJSON(res, 400, { error:'Email is required' });
    const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRe.test(email)) return sendJSON(res, 400, { error:'Invalid email address' });

    const subs = readJSON(FILES.subscribers);
    if (subs.find(s => s.email === email)) return sendJSON(res, 200, { success:true, message:'You\'re already subscribed! 🎉' });
    subs.push({ id: crypto.randomUUID(), email, subscribedAt: new Date().toISOString() });
    writeJSON(FILES.subscribers, subs);

    return sendJSON(res, 200, { success:true, message:'🎉 You\'re subscribed! Welcome to NeuraPath AI updates.' });
  }

  // POST /api/feedback
  if (pathname === '/api/feedback' && req.method === 'POST') {
    const body = await readBody(req);
    const { type, message, page } = body;
    if (!message) return sendJSON(res, 400, { error:'Feedback message required' });
    const feedbacks = readJSON(FILES.feedback);
    feedbacks.push({ id: crypto.randomUUID(), type: type || 'general', message, page: page || 'unknown', submittedAt: new Date().toISOString() });
    writeJSON(FILES.feedback, feedbacks);
    return sendJSON(res, 200, { success:true, message:'Thanks for your feedback! It helps us improve.' });
  }

  // GET /api/stats  (admin-style overview)
  if (pathname === '/api/stats' && req.method === 'GET') {
    return sendJSON(res, 200, {
      subscribers: readJSON(FILES.subscribers).length,
      contacts: readJSON(FILES.contacts).length,
      chatMessages: readJSON(FILES.chatHistory).length,
      savedPrompts: Object.values(readJSON(FILES.savedPrompts)).flat().length,
      prompts: Object.values(PROMPTS).flat().length,
      careers: CAREERS.length,
      projects: PROJECTS.length,
      roadmaps: Object.keys(ROADMAPS).length,
      tools: AI_TOOLS.length,
      blogPosts: BLOGS.length,
    });
  }

  // POST /api/resume/analyze
  if (pathname === '/api/resume/analyze' && req.method === 'POST') {
    const body = await readBody(req);
    const { resumeText, pdfBase64, fileName, jobRole } = body;

    const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';
    if (!ANTHROPIC_KEY) {
      return sendJSON(res, 500, { error: 'ANTHROPIC_API_KEY not set. Create a .env file with: ANTHROPIC_API_KEY=sk-ant-...' });
    }

    let finalText = resumeText || '';

    // If PDF sent as base64, extract text from it server-side
    if (pdfBase64) {
      try {
        const pdfBuf = Buffer.from(pdfBase64, 'base64');
        finalText = extractTextFromPdfBuffer(pdfBuf);
        if (!finalText || finalText.trim().length < 40) {
          finalText = `[PDF file: ${fileName || 'resume.pdf'} — text extraction limited, analyzing structure]`;
        }
      } catch(e) {
        finalText = resumeText || '';
      }
    }

    if (!finalText || finalText.trim().length < 40) {
      return sendJSON(res, 400, { error: 'Could not extract enough text. Please paste your resume text instead.' });
    }

    const prompt = `You are an expert resume reviewer and career coach with 15+ years of experience in tech hiring. Analyze the following resume${jobRole ? ` for the role of "${jobRole}"` : ''} and give a thorough, honest review.

Resume content:
"""
${finalText.slice(0, 7000)}
"""

Respond ONLY with a valid JSON object — no markdown, no backticks, no text outside the JSON. Use exactly this structure:
{
  "atsScore": <integer 0-100>,
  "overallGrade": "<one of: A+, A, A-, B+, B, B-, C+, C, C-, D>",
  "summary": "<3-4 honest sentences covering what works, what doesn't, and the single most critical improvement>",
  "strengths": ["<specific strength 1>", "<specific strength 2>", "<specific strength 3>"],
  "weaknesses": ["<specific weakness 1>", "<specific weakness 2>", "<specific weakness 3>"],
  "suggestions": [
    {"priority": "high", "area": "<section>", "tip": "<concrete actionable fix>"},
    {"priority": "high", "area": "<section>", "tip": "<concrete actionable fix>"},
    {"priority": "medium", "area": "<section>", "tip": "<concrete actionable fix>"},
    {"priority": "medium", "area": "<section>", "tip": "<concrete actionable fix>"},
    {"priority": "low", "area": "<section>", "tip": "<concrete actionable fix>"}
  ],
  "keywordsFound": ["<keyword1>", "<keyword2>", "<keyword3>", "<keyword4>", "<keyword5>"],
  "keywordsMissing": ["<missing1>", "<missing2>", "<missing3>", "<missing4>"],
  "sectionScores": {
    "contact": <0-100>,
    "summary": <0-100>,
    "experience": <0-100>,
    "skills": <0-100>,
    "education": <0-100>,
    "projects": <0-100>
  }
}`;

    const requestBody = JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1500,
      messages: [{ role: 'user', content: prompt }]
    });

    const options = {
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(requestBody),
      }
    };

    const aiReq = https.request(options, aiRes => {
      let data = '';
      aiRes.on('data', chunk => data += chunk);
      aiRes.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) return sendJSON(res, 500, { error: parsed.error.message || 'Anthropic API error' });
          const text = (parsed.content || []).map(c => c.text || '').join('').trim();
          // Strip any accidental markdown fences
          const clean = text.replace(/^```json\s*/i, '').replace(/```\s*$/,'').trim();
          const review = JSON.parse(clean);
          sendJSON(res, 200, { success: true, review });
        } catch(e) {
          console.error('Resume parse error:', e.message);
          sendJSON(res, 500, { error: 'Failed to parse AI response. Try again.' });
        }
      });
    });

    aiReq.on('error', err => {
      console.error('Anthropic request error:', err.message);
      sendJSON(res, 500, { error: 'AI service error: ' + err.message });
    });
    aiReq.write(requestBody);
    aiReq.end();
    return;
  }

  // ── STATIC FILE SERVING ────────────────────────────────────────────────────
  let filePath;
  if (pathname === '/' || pathname === '/index.html') {
    filePath = path.join(__dirname, 'public', 'index.html');
  } else {
    filePath = path.join(__dirname, 'public', pathname);
  }

  const ext = path.extname(filePath);
  const contentType = MIME[ext] || 'text/plain';

  fs.readFile(filePath, (err, content) => {
    if (err) {
      if (err.code === 'ENOENT') {
        // SPA fallback
        fs.readFile(path.join(__dirname, 'public', 'index.html'), (err2, html) => {
          if (err2) return sendJSON(res, 404, { error:'Not found' });
          res.writeHead(200, { 'Content-Type':'text/html' });
          res.end(html);
        });
      } else {
        sendJSON(res, 500, { error:'Server error' });
      }
    } else {
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content);
    }
  });
});

server.listen(PORT, () => {
  const hasKey = !!process.env.ANTHROPIC_API_KEY;
  console.log(`\n✦ NeuraPath AI Server running at http://localhost:${PORT}`);
  console.log(`  API:    http://localhost:${PORT}/api/health`);
  console.log(`  Chat:   POST http://localhost:${PORT}/api/noir/chat`);
  console.log(`  Resume: POST http://localhost:${PORT}/api/resume/analyze`);
  console.log(`  Data stored in: ${DATA_DIR}`);
  if (hasKey) {
    console.log(`  ✅ ANTHROPIC_API_KEY loaded — Resume Analyzer is active\n`);
  } else {
    console.log(`  ⚠️  ANTHROPIC_API_KEY not set — Resume Analyzer will not work`);
    console.log(`     Add it to a .env file: ANTHROPIC_API_KEY=sk-ant-...\n`);
  }
});
