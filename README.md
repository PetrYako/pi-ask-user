# pi-ask-user

A pi extension that gives the model an `ask_user` tool: ask the user one or more questions and block for an answer. Each question is either **multiple-choice** (2+ options, multi-select) or **free-text** (a pure clarification), and the user can always add a free-form note/answer alongside a selection.

Use it to clarify intent, get a decision, or confirm a direction — so the model asks instead of guessing.

## Install

```bash
pi install git:github.com/PetrYako/pi-ask-user
# or
pi install https://github.com/PetrYako/pi-ask-user
```

## Usage

<img width="1427" height="334" alt="Screenshot 2026-07-03 at 17 19 14" src="https://github.com/user-attachments/assets/5ba45b57-e146-422c-80a6-f5ff923cbefd" />

Once installed, the `ask_user` tool is available to the model. The model calls it like any other tool.

**Multiple-choice** — provide 2+ `options` (multi-select):

```json
ask_user({
  "questions": [
    {
      "question": "Where should we go this weekend?",
      "header": "Destination",
      "options": [
        { "label": "Beach",     "description": "relax, swim, read" },
        { "label": "Mountains", "description": "hike and explore" },
        { "label": "City",      "description": "museums and restaurants" }
      ]
    }
  ]
})
```

**Free-text** — omit `options` for an open question (e.g. a clarification):

```json
ask_user({
  "questions": [
    { "question": "What should we name the new variable?" }
  ]
})
```

Both forms accept an optional `header`, and a single call can carry up to 4 questions. With multiple questions the user navigates between them and can revise answers before submitting. `Enter` submits; `Esc` cancels.

The result carries the selected labels (if any) and the typed note/answer. On cancel, the tool returns a cancellation marker so the model can fall back to a sensible default.

## Keys

| Key | Multiple-choice | Free-text |
|-----|-----------------|-----------|
| `↑` / `↓` | Move between choices | Previous / next question (multi-question) |
| `Space` | Toggle the focused choice | — (type your answer) |
| `Tab` | Move focus to the note input | — |
| `←` / `→` | Navigate between questions (from a choice) | Move the caret in your answer |
| `Enter` | Submit, or advance to the next question | Submit, or advance to the next question |
| `Esc` | Cancel | Cancel |

From the note input in multiple-choice mode, `Tab` or `↑` returns focus to the choices.

## Layout

```
pi-ask-user/
├── ask_user.ts     # the extension
├── package.json    # pi-package manifest
└── README.md
```
