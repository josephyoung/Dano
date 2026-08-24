# OA OAuth2 logout contract research

Research date: 2026-08-24

## Conclusion

OAuth 2.0 Core does not require an authorization server to provide a browser logout URL. RFC 7009 standardizes token revocation, not termination of the authorization server's browser login session. Browser-redirect logout is standardized separately by OpenID Connect RP-Initiated Logout through an OP logout endpoint, normally advertised as `end_session_endpoint`.

For the public YunaiV/ruoyi-vue-pro ("Yudao") implementation examined here, the supported OAuth exit contract is deletion/revocation of a client's token. The project separately exposes an application authentication logout API that revokes the Bearer token supplied by that request. Current public source, official documentation, client metadata, and first-party tracker discussion do not expose an OIDC `end_session_endpoint` or another browser-navigable authorization-server logout contract.

Therefore, a Dano logout can revoke Dano's OA-issued OAuth token through the published OAuth endpoint, but that fact alone does not log the user out of an independently authenticated OA browser tab. Simultaneous OA browser logout requires an additional OA-owned contract, such as OIDC RP-Initiated Logout or a documented private browser logout URL/session mechanism.

## 1. Standards evidence

### OAuth 2.0 Core has no logout endpoint

[RFC 6749](https://www.rfc-editor.org/rfc/rfc6749.html) defines an authorization framework for obtaining limited access to HTTP resources. Its [protocol endpoints section](https://www.rfc-editor.org/rfc/rfc6749.html#section-3) defines the authorization endpoint and token endpoint; it does not define a logout endpoint or a protocol for ending an authorization server's browser session.

Consequently, the proposition that an OAuth 2.0 provider must offer a logout URL is false as a standards claim. Providers commonly offer logout URLs as proprietary extensions or because they also implement OpenID Connect, but that is not an OAuth 2.0 Core requirement.

### RFC 7009 revokes tokens; it does not define browser SSO logout

[RFC 7009](https://www.rfc-editor.org/rfc/rfc7009.html#section-2) supplements OAuth 2.0 with a token revocation endpoint. A client sends an HTTP `POST` containing the `token` parameter. The RFC says that the request invalidates the submitted access or refresh token and, where applicable, related tokens or the authorization grant.

The RFC notes that a client may revoke its tokens when an end user logs out, but the object being invalidated remains the client's token/grant. It does not specify clearing the authorization server's browser login state. It also requires the standard revocation request to use `POST`; Yudao's `DELETE /system/oauth2/token` has analogous revocation semantics but is not an RFC 7009-conforming endpoint by HTTP-method contract.

### OIDC defines browser-redirect logout

[OpenID Connect RP-Initiated Logout 1.0](https://openid.net/specs/openid-connect-rpinitiated-1_0.html#RPLogout) defines the missing browser-session operation: the Relying Party redirects the user's browser to the OpenID Provider's Logout Endpoint. The URL is normally learned through `end_session_endpoint`, and the request may carry `id_token_hint`, `post_logout_redirect_uri`, and `state`. The specification's [discovery metadata section](https://openid.net/specs/openid-connect-rpinitiated-1_0.html#OPMetadata) defines `end_session_endpoint` as the URL to which an RP redirects to request OP logout.

This also establishes a limitation on negative discovery evidence: the standard says the URL is normally obtained through discovery but may be learned by other mechanisms. Absence of OIDC discovery metadata alone cannot prove that no private logout URL exists.

## 2. Production OA framework fingerprint (anonymous, public evidence)

The following observations were made without using an OA account, browser storage, credentials, or authenticated APIs. They come only from the public [production login page](http://admin.dianshixinxi.com:90/login) and JavaScript assets referenced by that page on 2026-08-24.

### What the public frontend establishes

The production HTML identifies the application as “点狮全业务管理平台”. Its public metadata describes the frontend as `vue3 + CompositionAPI + typescript + vite3 + element plus`, and the page loads hashed ES modules under `/assets/`. The referenced public [`index-yXF1Gwsg.js`](http://admin.dianshixinxi.com:90/assets/index-yXF1Gwsg.js) bundle contains Vite's dynamic-import machinery and Element Plus components, and it loads a dedicated public [`SSOLogin-CBpuT2q3.js`](http://admin.dianshixinxi.com:90/assets/SSOLogin-CBpuT2q3.js) module. A read-only runtime inspection in the Codex in-app Browser reported Vue `3.5.12` and rendered Element Plus component namespaces. These are direct production frontend fingerprints captured on the research date; hashed asset URLs may change on a later deployment. In fact, the production main-bundle hash had changed since the 2026-08-21 inspection, while the OAuth flow described below remained the same. The version text in page metadata is operator-controlled, and the official frontend's current dependency versions differ, so neither signal should be treated as an exact upstream commit match.

More importantly, the production module graph and behavior closely match the official Yudao Vue 3 frontend pinned at [`a58e6de223b616b9dc14c95551d9d10faf5a280b`](https://github.com/yudaocode/yudao-ui-admin-vue3/tree/a58e6de223b616b9dc14c95551d9d10faf5a280b):

- the production bundle contains the source-module path `views/Login/components/SSOLogin.vue`, while the official repository has the same [`SSOLogin.vue`](https://github.com/yudaocode/yudao-ui-admin-vue3/blob/a58e6de223b616b9dc14c95551d9d10faf5a280b/src/views/Login/components/SSOLogin.vue);
- both expose the frontend route [`/sso`](https://github.com/yudaocode/yudao-ui-admin-vue3/blob/a58e6de223b616b9dc14c95551d9d10faf5a280b/src/router/modules/remaining.ts#L212-L221), parse `response_type`, `client_id`, `redirect_uri`, `state`, and `scope`, try auto-approval first, and then render the same consent choices and Chinese scope descriptions;
- both call `GET /system/oauth2/authorize?clientId=...` to initialize consent and `POST /system/oauth2/authorize` with form-encoded authorization parameters, as defined by the official frontend's [`src/api/login/oauth2/index.ts`](https://github.com/yudaocode/yudao-ui-admin-vue3/blob/a58e6de223b616b9dc14c95551d9d10faf5a280b/src/api/login/oauth2/index.ts);
- the production request client uses `/admin-api` as its API base, sets `Authorization: Bearer ...` from frontend-managed token state, and has `withCredentials: false`; and
- the production logout action calls `/system/auth/logout` and then clears frontend-local authentication/user state, matching the official client's [`login API`](https://github.com/yudaocode/yudao-ui-admin-vue3/blob/a58e6de223b616b9dc14c95551d9d10faf5a280b/src/api/login/index.ts) and [`user store`](https://github.com/yudaocode/yudao-ui-admin-vue3/blob/a58e6de223b616b9dc14c95551d9d10faf5a280b/src/store/modules/user.ts).

The production OAuth-client form module was also inspected as a public static asset. Its model contains `clientId`, `secret`, access/refresh-token validity, `redirectUris`, authorized grant types, scopes, auto-approve scopes, authorities, resource IDs, and `additionalInformation`. It contains no `post_logout_redirect_uris`, `logoutUri`, or `end_session_endpoint`. Likewise, the current production main and SSO bundles contain no `end_session_endpoint`, `post_logout_redirect_uri`, front-channel logout, back-channel logout, or OpenID discovery reference. This is direct evidence about the currently shipped frontend and configuration UI, but it remains negative frontend evidence rather than proof that no private backend or gateway route exists.

This is strong evidence that the production OA frontend is a customized build derived from `yudao-ui-admin-vue3`, not merely another Vue application that happens to use similar libraries. The public bundle also contains many OA-specific modules and branding, so it is not an unmodified upstream build.

### What the public frontend does not establish

Static frontend evidence cannot identify the exact backend artifact, Git commit, database schema, reverse-proxy controller map, or private patches. The production API paths and response flow are consistent with `YunaiV/ruoyi-vue-pro`, but a compatible private backend or fork could implement the same contract. Therefore, this document uses “production OA appears to be a customized Yudao/ruoyi-vue-pro deployment” as the framework conclusion; it does not claim byte-for-byte backend identity.

The same boundary applies to logout. Absence of `end_session_endpoint` and OIDC logout fields from public frontend code is evidence about the shipped browser client, not proof that an operator has not added an undocumented reverse-proxy or backend-only route.

## 3. Upstream Yudao architecture and OAuth2 SSO integration

### Backend and frontend ownership

The official [`YunaiV/ruoyi-vue-pro`](https://github.com/YunaiV/ruoyi-vue-pro/tree/2bbe79b34ab8c9c7b0148300599dc8d4881c8db1) repository is the Java backend. Its project description and module layout identify a Spring Boot/MyBatis Plus backend, with authentication and OAuth2 controllers in `yudao-module-system`. The official [`yudaocode/yudao-ui-admin-vue3`](https://github.com/yudaocode/yudao-ui-admin-vue3/tree/a58e6de223b616b9dc14c95551d9d10faf5a280b) repository is the separate Vue 3/TypeScript/Vite/Element Plus administration frontend.

The project's own [OAuth 2.0 guide](https://doc.iocoder.cn/oauth2/#oauth-2-0-%E6%8A%80%E6%9C%AF%E9%80%89%E5%9E%8B) makes a material architectural point: Yudao did **not** wire its authorization server through Spring Authorization Server. It says the project implemented OAuth2 itself after referring to multiple frameworks. Consequently, assumptions based on standard SAS endpoint auto-configuration, OIDC discovery, or an automatically supplied logout endpoint do not apply unless the deployed OA added them separately.

### Authorization-code SSO flow implemented by Yudao

The official [authorization-code SSO walkthrough](https://doc.iocoder.cn/oauth2/#%E5%AE%9E%E6%88%98%E4%B8%80-%E5%9F%BA%E4%BA%8E%E6%8E%88%E6%9D%83%E7%A0%81%E6%A8%A1%E5%BC%8F-%E5%AE%9E%E7%8E%B0-sso-%E5%8D%95%E7%82%B9%E7%99%BB%E5%BD%95) and the two pinned source repositories establish this division of work:

1. The OAuth client sends the user's browser to the OA frontend `/sso` route with the standard authorization request fields.
2. If OA's own administration frontend is not logged in, the guide says OA first shows its ordinary login page. After that login it returns to the SSO consent flow. Thus OA browser authentication is a prerequisite state owned by the OA frontend/backend pair.
3. [`SSOLogin.vue`](https://github.com/yudaocode/yudao-ui-admin-vue3/blob/a58e6de223b616b9dc14c95551d9d10faf5a280b/src/views/Login/components/SSOLogin.vue) uses the OA browser's Bearer credential to initialize and submit consent to `/system/oauth2/authorize`. On success it navigates to the URL returned by OA.
4. [`OAuth2OpenController`](https://github.com/YunaiV/ruoyi-vue-pro/blob/2bbe79b34ab8c9c7b0148300599dc8d4881c8db1/yudao-module-system/src/main/java/cn/iocoder/yudao/module/system/controller/admin/oauth2/OAuth2OpenController.java) validates the authorization request and produces an authorization code/redirect result.
5. The client application's server exchanges that short-lived code at `POST /system/oauth2/token` using its client authentication. The official guide explicitly places this exchange in the client backend, which then returns or binds the resulting access token according to the client's own session design.
6. Later refresh, identity/API access, and revocation operate on the OAuth token issued for that OAuth client. They are not operations on the independent OA administration browser token used in steps 2 and 3.

This explains why “OA already logged in, then open Dano” can support silent or low-friction **login** through a fresh authorization flow, while “Dano revokes its provider token” cannot by itself clear the separate OA browser login. The authorization code, OAuth access/refresh token, OA browser token, and Dano application session have different owners and lifetimes.

## 4. Current public Yudao logout implementation

The source observations below are pinned to ruoyi-vue-pro `master` commit [`2bbe79b34ab8c9c7b0148300599dc8d4881c8db1`](https://github.com/YunaiV/ruoyi-vue-pro/tree/2bbe79b34ab8c9c7b0148300599dc8d4881c8db1), resolved again on 2026-08-24.

### Public OAuth routes

[`OAuth2OpenController`](https://github.com/YunaiV/ruoyi-vue-pro/blob/2bbe79b34ab8c9c7b0148300599dc8d4881c8db1/yudao-module-system/src/main/java/cn/iocoder/yudao/module/system/controller/admin/oauth2/OAuth2OpenController.java) is rooted at `/system/oauth2` and declares only these mappings:

- `POST /token`
- `DELETE /token`
- `POST /check-token`
- `GET /authorize`
- `POST /authorize`

The [`DELETE /token` implementation](https://github.com/YunaiV/ruoyi-vue-pro/blob/2bbe79b34ab8c9c7b0148300599dc8d4881c8db1/yudao-module-system/src/main/java/cn/iocoder/yudao/module/system/controller/admin/oauth2/OAuth2OpenController.java#L144-L156) is described as “删除访问令牌”. It authenticates the OAuth client and calls `revokeToken(clientId, token)`. It returns an API result; it is not a user-agent navigation endpoint and has no post-logout redirect contract.

A repository-wide search of this pinned public source returned no implementation references for `end_session_endpoint`, `post_logout_redirect_uri`, `id_token_hint`, or `.well-known/openid-configuration`.

### Application authentication logout is a Bearer-token API

[`AuthController`](https://github.com/YunaiV/ruoyi-vue-pro/blob/2bbe79b34ab8c9c7b0148300599dc8d4881c8db1/yudao-module-system/src/main/java/cn/iocoder/yudao/module/system/controller/admin/auth/AuthController.java#L73-L82) exposes `POST /system/auth/logout`. The method extracts the current request's configured authorization token and passes that token to `authService.logout(...)`. It does not redirect a browser or identify a separate browser session through a cookie.

The current official Vue 3 client, pinned to [`a58e6de223b616b9dc14c95551d9d10faf5a280b`](https://github.com/yudaocode/yudao-ui-admin-vue3/tree/a58e6de223b616b9dc14c95551d9d10faf5a280b), [calls `POST /system/auth/logout`](https://github.com/yudaocode/yudao-ui-admin-vue3/blob/a58e6de223b616b9dc14c95551d9d10faf5a280b/src/api/login/index.ts) and then [removes its locally stored token and user cache](https://github.com/yudaocode/yudao-ui-admin-vue3/blob/a58e6de223b616b9dc14c95551d9d10faf5a280b/src/store/modules/user.ts). This is application-local token logout, not an OP logout redirect contract available to another origin.

### OAuth client metadata has no logout registration field

The current [`OAuth2ClientDO`](https://github.com/YunaiV/ruoyi-vue-pro/blob/2bbe79b34ab8c9c7b0148300599dc8d4881c8db1/yudao-module-system/src/main/java/cn/iocoder/yudao/module/system/dal/dataobject/oauth2/OAuth2ClientDO.java) and [`OAuth2ClientSaveReqVO`](https://github.com/YunaiV/ruoyi-vue-pro/blob/2bbe79b34ab8c9c7b0148300599dc8d4881c8db1/yudao-module-system/src/main/java/cn/iocoder/yudao/module/system/controller/admin/oauth2/vo/client/OAuth2ClientSaveReqVO.java) contain authorization redirect URIs, grant types, scopes, auto-approve scopes, authorities, resources, and additional information. They do not define `post_logout_redirect_uris` or an equivalent explicit logout callback field.

This supports the narrower conclusion that the public implementation has no registered OIDC-style logout contract. It does not rule out an operator placing an undocumented URL in unstructured `additionalInformation` or adding a private deployment extension.

## 5. Official documentation and historical context

The official [OAuth 2.0 (SSO) guide](https://doc.iocoder.cn/oauth2/) describes client-side “退出登录” as deleting the Token. Its tutorial index calls the operation “退出时，如何删除 Token 令牌？” and the implementation topic “如何校验、刷新、删除访问令牌？”. It documents authorization-code and password-mode SSO, but does not document an OP browser logout endpoint, `end_session_endpoint`, an ID token, or a post-logout redirect registration.

The official [v1.6.2 changelog](https://doc.iocoder.cn/changelog/1.6.2/) records the June 2022 introduction of OAuth2 access/refresh tokens and OAuth2-based SSO. The published feature history says SSO login was added; it does not announce OIDC or single logout. The same documentation family explains user logout as invalidating/deleting a Token rather than terminating a shared browser session.

This historical evidence is consistent with the current source: Yudao implemented an OAuth2 authorization/token server and token-backed application authentication, not a complete OpenID Provider with RP-Initiated Logout.

## 6. First-party GitHub issues and discussions

No first-party issue was found in the official repository that publishes an additional OAuth/OIDC logout URL. Exact GitHub issue searches, last repeated on 2026-08-24, for `单点登出`, `OAuth2 登出`, `OAuth2 注销`, `SSO 登出`, `SSO 注销`, `OAuth2 退出`, `oauth2 logout`, `sso logout`, and `token revocation` returned no relevant logout-contract discussion. The repository does not have GitHub Discussions enabled.

The closest first-party issues are useful mainly for defining what they do **not** establish:

- [Issue #755](https://github.com/YunaiV/ruoyi-vue-pro/issues/755) concerns an authorization-code SSO login page being blocked by permissions. The [maintainer response](https://github.com/YunaiV/ruoyi-vue-pro/issues/755#issuecomment-2680135816) discusses demo ports and anonymous-access configuration, not logout.
- [Issue #732](https://github.com/YunaiV/ruoyi-vue-pro/issues/732) asks about CAS integration and includes a comment about OIDC. The [maintainer closes it because nobody had provided the integration](https://github.com/YunaiV/ruoyi-vue-pro/issues/732#issuecomment-2726435886); it provides no evidence that an OIDC provider or OIDC logout exists.
- [Issue #132](https://github.com/YunaiV/ruoyi-vue-pro/issues/132) concerns an embedded UI that failed to navigate to the login page after logout. The [maintainer says the latest version fixed it](https://github.com/YunaiV/ruoyi-vue-pro/issues/132#issuecomment-1107456545). This is an application UI/navigation issue, not SSO single logout.

These results are negative evidence only. Search incompleteness, deleted issues, private support discussions, or terminology not covered by the queries remain possible.

## 7. Implication for Dano and OA

The two relevant credentials must not be conflated:

1. Dano holds an OAuth access token issued for Dano's OAuth client. Calling OA's `DELETE /system/oauth2/token` with that client credential can revoke that token.
2. An OA browser frontend can hold its own application access token and sends it to `POST /system/auth/logout`; its own frontend then clears local browser storage.

Revoking item 1 does not identify or delete item 2. A Dano server request to `/system/auth/logout` could only revoke the Bearer token it supplies; it cannot cause OA's frontend, on another origin, to clear OA's browser-local token. A cross-origin page also cannot read another origin's local storage under the browser same-origin boundary.

The supported ways to make “Dano logout also logs the OA browser out” reliable are therefore:

- OA adds or documents an OIDC RP-Initiated Logout endpoint and the relevant client/post-logout metadata; or
- OA adds a deliberately designed browser-navigation logout endpoint backed by an OA-recognized browser session, with redirect and CSRF/login-CSRF behavior specified; or
- the architecture changes so both frontends intentionally share an authentication/session authority under an explicit, reviewed contract.

Calling both existing token APIs without such a contract is not equivalent to browser single logout.

## 8. Limits of this conclusion

This research establishes the state of public standards, current public upstream source, current official UI source, official documentation, and searchable first-party GitHub discussion. It does **not** prove that a particular production OA deployment has no additional endpoint. Production may use:

- a private fork;
- reverse-proxy routes not present upstream;
- custom authentication middleware;
- an undocumented endpoint;
- a different frontend/token storage design; or
- code deployed from a different commit.

To elevate the conclusion to “the production OA definitely has no browser logout contract,” inspect the deployed OpenAPI/controller mappings or deployment source, check any discovery/metadata endpoint and proxy configuration, and perform a safe endpoint/browser-session test against that deployment. Until then, the exact conclusion is: **no such contract is present in or documented by the public upstream evidence reviewed here**.
