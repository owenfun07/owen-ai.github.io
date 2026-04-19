# owen-ai.github.io

## Environment variables

- `GEMINI_API_KEY` (required): Gemini API key.
- `GEMINI_MODEL` (optional): defaults to `gemini-2.5-flash`.
- `AUTH_SERVICE_URL` (required for real login/signup): your Google Apps Script Web App URL connected to Google Sheets.
- `ENABLE_GEMINI_DEBUG` (optional): set to `true` to enable `GET /debug-gemini` for troubleshooting upstream Gemini responses.

## Pages

- `/` guest-friendly home/start page.
- `/login.html` optional login/signup page (Google Sheets-backed auth).
- `/chat.html` chat page (works as guest or logged-in user).
  - Chat history is saved only for logged-in users.
  - Image upload/paste is available only when logged in.
