# pi-ask-user

A pi extension that lets the model ask the user one or more multiple-choice questions and block until they answer (or cancel). The picker is multi-select and always includes an optional free-text note alongside the choices.

## Install

```bash
pi install git:github.com:PetrYako/pi-ask-user
```

## Usage

Once installed, the `ask_user` tool is available to the model. The model calls it like any other tool:

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

Each question has 2+ options. With multiple questions in one call, the user can navigate between them with `←` / `→` and revise answers before submitting. `Enter` submits; `Esc` cancels.

The result carries the selected labels and the typed note (if any). On cancel, the tool returns a cancellation marker.

## Keys

| Key | Action |
|-----|--------|
| `↑` / `↓` | Move between choices |
| `Tab` | Move focus to the note input |
| `Space` | Toggle the focused choice |
| `←` / `→` | Navigate between questions (multi-question calls) |
| `Enter` | Submit (or advance to the next question) |
| `Esc` | Cancel |

## Layout

```
pi-ask-user/
├── ask_user.ts     # the extension
├── package.json    # pi-package manifest
└── README.md
```
