# Team Code Editor

A web app where teammates log in, open the same file and **type together in real time**, then press **Run** to compile and run it with real compilers: **Python, Java, C and C++**. Everyone sees the same code, the same output, live cursors with names, and who is online.

| Feature | How it's built |
| --- | --- |
| Simultaneous editing, no conflicts | Yjs (CRDT) + CodeMirror 6 + y-websocket |
| Live cursors, "who is in this file" | Yjs awareness |
| "Who is online" across the site | a small `/presence` WebSocket on the server |
| Login / signup | JWT + bcrypt |
| Code saved for everyone | Yjs state saved to disk (`server/data`) every second |
| Real compilers | `python3`, `gcc`, `g++`, `javac`/`java` run by the server in a temp folder with time/memory/output limits |
| Shared output | the server writes the run result into the shared document, so every teammate sees it |

```
team-code-editor/
├─ client/   React + Vite (login, dashboard, editor)
├─ server/   Node + Express + WebSocket (auth, sync, presence, code runner)
├─ Dockerfile, docker-compose.yml, render.yaml
└─ package.json   (shortcuts: setup, dev, build, start)
```

---

## 1. Run it in VS Code (your laptop)

### Install these once
| Tool | Check with | Notes |
| --- | --- | --- |
| Node.js 18 or newer | `node -v` | https://nodejs.org |
| Python 3 | `python3 --version` (Windows: `python --version`) | |
| GCC and G++ | `gcc --version` and `g++ --version` | Windows: install **MSYS2/MinGW-w64** and add its `bin` folder to PATH, or use WSL. macOS: `xcode-select --install` |
| JDK (not just JRE) | `javac -version` | https://adoptium.net |

If a command has another name on your machine, set it with environment variables (see `.env.example`), e.g. `PYTHON_CMD=py`.

### Start
Open the `team-code-editor` folder in VS Code, open the terminal (Ctrl + `) and run:

```bash
npm run setup     # installs everything (root, server, client) - once
npm run dev       # starts the server (port 4000) and the client (port 5173)
```

Open **http://localhost:5173**, create an account, create a project.

### Try the collaboration yourself
Open a second browser window in **private/incognito mode**, create a second account, open the same project. Type in one window and watch the other. Press **▶ Run** (or Ctrl/Cmd + Enter): both windows show the output.

To let a teammate on the same Wi-Fi try it, they can open `http://YOUR-LAPTOP-IP:5173` (start the client with `npm --prefix client run dev -- --host`).

### Run the production version locally
```bash
npm run build
npm start         # http://localhost:4000 (server also serves the built client)
```

### Or run everything in Docker (no compilers needed on your machine)
```bash
docker compose up --build     # http://localhost:4000
```

---

## 2. Deploy on Render (recommended: one service does everything)

The server needs WebSockets and real compilers, so it must run in a container on a normal server. That is what Render's Docker service gives you. The Dockerfile already installs Python, GCC, G++ and the JDK.

1. Push this folder to a **GitHub repository**.
2. On https://render.com: **New + → Web Service → connect the repo**.
   - **Runtime / Language:** Docker (it finds the `Dockerfile`)
   - **Instance type:** Free to try, see the warning below for real use
   - **Health check path:** `/api/health`
3. **Environment** tab → add `JWT_SECRET` = a long random string
   (`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`).
4. Deploy. The first build takes several minutes. Your app is at `https://<name>.onrender.com`.

You can also use the included `render.yaml`: **New + → Blueprint → pick the repo**.

### ⚠️ Important: saving on Render's free plan
Render's free web services have an **ephemeral filesystem**: files are lost on every redeploy, restart and after the service sleeps (it sleeps after 15 minutes without traffic, and takes about a minute to wake up). On the free plan, **accounts and saved code will be reset**. That is fine for a demo, not for a team that needs its work kept.

To keep data permanently, pick one:
- **Paid instance + persistent disk** (the simplest): in `render.yaml` uncomment the `disk:` block, use a paid plan, and set the env var `DATA_DIR=/var/data`.
- **A database** instead of the JSON files: replace `server/src/store.js` with PostgreSQL calls (Render has a Postgres service). I can do this change for you.

### Security note about running other people's code
The runner gives each run its own temp folder, a time limit (5 s), an output limit, memory/CPU/process limits, a clean environment, and in the Docker image it runs the code as a **different unprivileged user** that cannot read your user data or secrets. That is reasonable for **a trusted team**. It is **not a fully hardened sandbox**: code can still make network requests, for example. If you open this to the public, run the code in a dedicated sandbox such as **Judge0** or per-run Docker containers with `--network none`, and put the app behind sign-up approval.

---

## 3. Optional: put the React client on Vercel

Vercel can host only the **client** (static files). It **cannot** run the server (no long-lived WebSockets, no compilers), so the server must still be on Render (step 2). You do not need Vercel at all, since Render already serves the client. Use it only if you want the client on Vercel.

1. Deploy the server on Render first and note its URL, e.g. `https://team-code-editor.onrender.com`.
2. On Render, add the env var `CLIENT_ORIGIN` = your future Vercel URL (e.g. `https://team-code-editor.vercel.app`; you can set it after step 3).
3. On https://vercel.com: **Add New → Project → import the repo**, then:
   - **Root Directory:** `client`
   - **Framework Preset:** Vite (auto-detected; build `npm run build`, output `dist`)
   - **Environment Variable:** `VITE_API_URL` = `https://team-code-editor.onrender.com` (no trailing slash)
4. Deploy, then make sure `CLIENT_ORIGIN` on Render matches the final Vercel URL and redeploy Render if you changed it.

---

## 4. How it works (for your viva/presentation)

1. **Login:** `POST /api/login` returns a JWT. The browser keeps it and sends it with every request and WebSocket connection.
2. **Real-time editing:** each project is a Yjs document. Every keystroke becomes a tiny Yjs update sent over a WebSocket to the server, which forwards it to everyone else. Yjs merges simultaneous edits mathematically, so there are no overwritten changes.
3. **Saving:** the server stores the document state in `server/data/docs/<project>.bin` one second after the last edit and when the last person leaves.
4. **Presence:** the editor shows who is in the file (Yjs awareness: name, colour, cursor). A second WebSocket (`/presence`) tells every page who is online and which project they are in; dead connections are removed using ping/pong.
5. **Running code:** `POST /api/projects/:id/run` reads the code from the shared document, writes it to a temp folder, compiles it (`gcc`, `g++`, `javac`) or runs it directly (`python3`), then puts the result into the shared document so every teammate sees it.

## 5. Troubleshooting

| Problem | Fix |
| --- | --- |
| `Command not found: g++` (or javac, python3) in the output panel | Install it and make sure it's on PATH, then restart `npm run dev` |
| Java says `class X is public, should be declared in a file named X.java` | The runner names the file after your `public class`. Make sure there is only one public class |
| Login screen after restarting the server | Set `JWT_SECRET` so tokens survive restarts (in production) |
| "Offline – reconnecting" | The server is asleep (Render free) or stopped. Wait a minute |
| Port already in use | Change `PORT` for the server and the proxy target in `client/vite.config.js` |
| Windows: `rm`/`ulimit` errors | You don't need either on Windows; resource limits are applied only on Linux/macOS (use Docker or WSL to get them) |

## Ideas for next steps
- Multiple files per project / a file tree
- Per-project invitations instead of one shared workspace
- PostgreSQL storage, project delete/rename
- Judge0 or per-run Docker containers for stronger sandboxing
- Chat or comments next to the editor
