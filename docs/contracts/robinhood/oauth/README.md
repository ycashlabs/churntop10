# Robinhood Trading MCP OAuth contract

Captured live on 2026-11-13T00:59Z (UTC) from `https://agent.robinhood.com`. Standards: RFC 9728 (protected resource metadata), RFC 8414 (authorization server metadata), RFC 7591 (dynamic client registration), RFC 7636 (PKCE), RFC 8707 (`resource`), RFC 9207 (`iss` on the callback), RFC 8252 (loopback redirect for native/public clients).

## Protected resource metadata (`protected-resource.json`)

Fetched from the `resource_metadata` URL in the 401 `WWW-Authenticate` header of `POST /mcp/trading`, falling back to the path-inserted `/.well-known/oauth-protected-resource/mcp/trading`.

| Field | Type | Required | Use |
| --- | --- | --- | --- |
| `authorization_servers` | string[] | required | first entry is the issuer for metadata discovery |
| `resource` | string | required | sent as `resource` on authorize, token, and refresh |
| `scopes_supported` | string[] | optional | informational |
| `bearer_methods_supported` | string[] | optional | informational (`header`) |

## Authorization server metadata (`authorization-server.json`)

| Field | Type | Required | Use |
| --- | --- | --- | --- |
| `issuer` | string | required | must equal the callback `iss` |
| `authorization_endpoint` | string | required | browser sign-in (`https://robinhood.com/oauth`) |
| `token_endpoint` | string | required | code exchange and refresh |
| `registration_endpoint` | string | required | dynamic registration |
| `code_challenge_methods_supported` | string[] | required, must include `S256` | PKCE |
| `scopes_supported` | string[] | optional, default `internal` | `scope` on authorize |
| `authorization_response_iss_parameter_supported` | boolean | optional, default false | when true the callback must carry `iss` |
| `token_endpoint_auth_methods_supported` | string[] | optional | `none` (public client) |
| `grant_types_supported`, `response_types_supported` | string[] | optional | informational |

## Dynamic registration

Request (`registrationBody`): `client_name`, `redirect_uris`, `grant_types`, `response_types`, `token_endpoint_auth_method: "none"`, `scope: "internal"`.

Response (`registration-response.json`):

| Field | Type | Required | Use |
| --- | --- | --- | --- |
| `client_id` | string | required | authorize, token, refresh |
| `redirect_uris` | string[] or null | optional | echo only |
| `client_name` | string | optional | always `Robinhood Trading` |
| `token_endpoint_auth_method` | string | optional | `none` |

Important finding: registration is not a real registration. Every request returns the same shared public `client_id` (a few partner names such as `Claude` get a fixed partner id), and it echoes any `redirect_uris`, including `https://evil.example.com/cb` (`registration-response-https.json` shows the dev web address echoed back). The echo does not add the address to Robinhood's allow-list. Robinhood checks `redirect_uri` on its side when the user approves, and for the shared client it accepts loopback addresses (`http://127.0.0.1:<port>/callback`, as Churn Capital uses). A public web address such as `https://top10-dev.ycashlabs.com/api/robinhood/callback` is refused, and robinhood.com shows "Uh oh! Something's gone wrong… An unexpected error occurred while connecting this application to Robinhood." (the web app's `AUTHORIZE_SUBMIT_FAILURE` path).

So Churn Top 10 uses the loopback redirect `http://127.0.0.1:47621/callback`. After approving, the browser tries to open that address on the user's own computer, nothing answers, and the address bar holds `?code=…&state=…&iss=…`. The user pastes that address into Settings, and the Worker finishes the exchange with the PKCE verifier it kept. The code is useless without that verifier, and `state` is single use and expires after 10 minutes.

## Callback (pasted loopback address)

| Field | Required | Check |
| --- | --- | --- |
| `code` | required | exchanged once |
| `state` | required | must match a saved, unexpired row; deleted on first use |
| `iss` | required when `authorization_response_iss_parameter_supported` is true | must equal `issuer` |
| `error`, `error_description` | optional | shown to the user, no exchange |
