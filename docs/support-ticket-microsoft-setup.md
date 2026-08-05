# Microsoft setup for support tickets

The support-ticket backend is implemented fail closed. Keep
`SUPPORT_TICKETS_ENABLED=false` until the Microsoft account, Entra application,
OneDrive folder, and production smoke checks are ready.

## Server environment

Configure these values only in the backend environment:

- `MICROSOFT_TENANT_ID`
- `MICROSOFT_CLIENT_ID`
- `MICROSOFT_CLIENT_SECRET`
- `MICROSOFT_REFRESH_TOKEN`
- `MICROSOFT_GRAPH_SCOPES` (optional; only an already-consented scope subset)
- `MICROSOFT_ONEDRIVE_DRIVE_ID`
- `ONEDRIVE_SUPPORT_FOLDER`
- `SUPPORT_TICKETS_ENABLED`

Never expose Microsoft credentials through `VITE_*` variables or send them to
the browser. `VITE_SUPPORT_TICKETS_ENABLED` controls UI visibility only and is
not a security boundary.

## Future manual setup

1. Obtain a Microsoft work or school tenant.
2. Create an application registration in Microsoft Entra ID.
3. Configure it as a server-side confidential application.
4. Grant the delegated Microsoft Graph `Files.ReadWrite` permission.
5. Include `offline_access` during the future interactive consent flow.
6. Implement and complete the authorization-code consent flow.
7. Obtain the refresh token through that flow without exposing it to the client.
8. Store tenant, client, and refresh credentials only in protected server
   environment or secret storage.
9. Determine the target OneDrive drive ID.
10. Create and configure the support-ticket folder in that drive.
11. Create a Power Automate flow that watches the same OneDrive folder.
12. Configure the flow to notify CVMS administrators through Gmail.
13. Configure the required mobile notification action.
14. Enable `SUPPORT_TICKETS_ENABLED` on the backend first.
15. Run a production smoke test with a non-sensitive support ticket.
16. Enable `VITE_SUPPORT_TICKETS_ENABLED` only after the backend succeeds.

## Security limitations

- Interactive Microsoft authorization is not implemented yet.
- The frontend must never receive tenant credentials, client secrets, access
  tokens, or refresh tokens.
- Real tokens must not be committed, logged, copied into screenshots or videos,
  or included in reports.
- If Microsoft rotates a refresh token, the current provider uses the rotated
  value only in memory for the lifetime of that Node.js process.
- In-memory rotation does not replace protected persistent secret storage. A
  process restart falls back to the refresh token supplied by the server
  environment.
