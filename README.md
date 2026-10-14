# Thesis Debate Studio

Vite + React + TypeScript moderator UI prototype for a local-LLM, 3-vs-3 debate workflow.

## Run locally

```sh
npm install
npm run dev
```

`npm run build` runs the TypeScript project build and produces the static app in `dist/`.

## Included in this prototype

- Fresh-session topic check and explicit start gate powered by the judgment model.
- Structured six-turn speaking order with optional moderator instructions and force-stop controls.
- Free-debate monitor that checks every 5 seconds while idle, proposes one agent and target at a time, and generates a speech only after moderator approval.
- Five independent jury prompts with scores and rationales shown as each judge completes, highest/lowest-trimmed mean, and tie handling.
- Responsive live transcript, model status, and moderator dashboard.

## Ollama models

- `qwen2.5:3b` generates structured turns and approved free-debate speeches, streaming into the transcript. Force stop aborts the active request.
- `qwen2.5:1.5b` checks topic suitability and runs five sequential jury evaluations with different rubric prompts. The team scores are trimmed independently.

The transcript and interruption requests start empty. Generated speeches, topic checks, free-debate monitoring, and jury scores use the local Ollama API. All current session state stays in browser memory and is lost on refresh by design; no backend or persistence is included.

During `npm run dev`, Vite proxies `/ollama/*` to `http://127.0.0.1:11434`, avoiding browser CORS configuration. The proxy is development-only; a production deployment should put a local backend such as FastAPI between the browser and Ollama and handle session persistence there.

## Architecture notes

- The development UI streams turns and aborts the active fetch on force stop. The free monitor checks the transcript every 5 seconds while enabled and idle, then checks again after an approved or rejected request. It never overlaps model-monitor calls.
- Treat the lightweight model's intervention as a proposal only. The UI validates the proposed speaker against the six-agent roster and requires moderator approval before generating the full response.
- Each judge returns two scores and a short rationale. The UI displays the rationales and removes one maximum and minimum independently from each team's five scores.
- Before using this for real judging, define whether the two team scores are independent and how ties, malformed judge output, and judge failures are handled. The Olympic-style trimmed mean should remove one maximum and one minimum per team's five scores independently.