# Security

## Reporting

Report issues privately to the repository maintainer. Use GitHub Private Vulnerability Reporting if enabled. Include affected versions, relevant conditions, and sanitized evidence. Keep credentials, private chats, attachment URLs and database copies out of reports.

## Secrets and incidents

Use dedicated Discord and provider credentials injected through the environment or a local, ignored `.env`. Limit filesystem access to the bot account. Apply provider-side budgets and restrictions. If a key or webhook was exposed, revoke it and replace it immediately. Deleting it from the latest file leaves any exposed historical copies usable until revoked.

The application records event names and sanitized status categories. It detects configured secrets and common credential patterns in text before sending prompts or displaying or saving responses. Redaction does not inspect image pixels, encrypted content, or secrets encoded into different forms. Keep secrets out of prompts and images.

## Boundaries

- The AI adapters can return model text and usage. Commands, network destinations, secrets, and local file access are controlled by the application. The bot grants no tools or external actions to the models.
- Image input accepts one bounded Discord CDN attachment and checks its origin, route, declared and actual length, MIME type, format signature, and dimensions. Redirects are disabled. The provider receives inline image data with the selected request.
- Model output cannot trigger Discord mention notifications. Message splitting stays within Discord’s character limit, link previews are suppressed for generated replies, and common masked link markup is removed.
- SQLite uses bound parameters, retention sweeps, and secure deletion for history rows. Durable transcripts require AES-256-GCM encryption and a separate key. Store databases on local disk with owner-only access, especially on Windows where directory ACLs are managed by the operator. Keep history backups and keys separate.
- Rate limits, deduplication and concurrency limits are local to the process. Run one active process per token. Coordinated limits and history would need shared state before horizontal deployment.
- Disabling a provider prevents further submissions for that guild. Requests already submitted to a provider may still complete remotely. Streaming can display partial text before the provider returns a final status.

## Verification

CI scans the checked-out files and Git history with Gitleaks and checks dependencies with npm audit. Unit and integration tests cover token redaction, permission and session boundaries, attachment restrictions, request limits, streaming behavior, and malformed provider responses. Before production use, verify the deployed app and bot permissions, provider billing and privacy settings, and the file permissions and backup retention of the host.
