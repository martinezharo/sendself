# AGENTS.md
## Project
SendSelf is the name of a web app designed to share files and text between your own devices in a fast and intuitive way, with a UI/UX closer to a messaging app than to other tools with the same purpose.
This repository is a VERY EARLY WIP. Proposing sweeping changes that improve long-term maintainability is encouraged.
## Key features
* Connect your devices once and forget about it.
* You can share your stuff without the other devices needing to be online, just like you would on WhatsApp or Telegram.
## Priorities
* Optimal performance on both frontend and backend.
* Excellent security and privacy, as long as it doesn't hurt UX too much.
## Maintainability
Long term maintainability is a core priority. If you add new functionality, first check if there is shared logic that can be extracted to a separate module. Duplicate logic across multiple files is a code smell and should be avoided. Don't be afraid to change existing code. Don't take shortcuts by just adding local logic to solve a problem.
