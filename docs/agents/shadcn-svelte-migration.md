# Dano shadcn-svelte component system

This document is the source of truth for Dano's browser component boundary. It records the generated registry baseline, the feature migration decisions, and the intentional exceptions. Feature components must import public components from `apps/dano/web/src/components/ui`; only those wrappers may import Bits UI directly.

## Toolchain and generation workflow

Dano uses Tailwind CSS 4 through `@tailwindcss/vite`. `apps/dano/components.json` is the official shadcn-svelte CLI configuration, `apps/dano/web/src/app.css` is the Tailwind entrypoint and maps shadcn semantic tokens to Dano's runtime theme variables, and `$lib` resolves to `apps/dano/web/src`.

Run the CLI from `apps/dano` so it reads the web TypeScript configuration:

```sh
cd apps/dano
pnpm dlx shadcn-svelte@latest add <component>
```

Generated files are checked into the repository. Review a generated update for the following Dano adaptations before committing it:

- Keep floating-layer portal defaults at `.app-shell`, where the active runtime theme variables live.
- Preserve the shared `--layer-*` ordering in `web/src/app.css`; feature components must not assign cross-feature `z-index` values.
- Keep feature components free of direct `bits-ui` imports.
- Preserve existing feature visuals and interaction contracts; registry updates do not authorize a redesign.
- Run the component boundary test, targeted feature tests, `pnpm run check`, `pnpm test`, `pnpm run build`, and the relevant browser acceptance.

The initial convergence used `shadcn-svelte` 1.5.0 with the current `vega`/Lucide registry and the neutral base color.

## Public component matrix

| Capability | Public implementation | Current callers | Dano adaptation and executable evidence |
| --- | --- | --- | --- |
| Button | `ui/button` | `AppHeader`, `AppRightSidebar`, `ThemeSettingsDialog`, `ExtensionDialog`, `ImageLightbox`, `AppNotificationToast` | Official variants and sizes. Feature-level visual classes remain overrides rather than duplicate button primitives; covered by the corresponding feature tests and rendered flows below. |
| Input | `ui/input` | `ExtensionDialog` | Official input. Native question inputs remain only where the form/mobile exception below applies; `ExtensionDialog.test.ts` covers the protocol response seam. |
| Textarea | `ui/textarea` | `ExtensionDialog` | Official textarea with the existing editor response contract; covered by `ExtensionDialog.test.ts`. |
| Select | `ui/select` | Registry baseline; no feature caller currently | Official Bits-backed select with `.app-shell` portal. Native question selects remain an intentional form/mobile exception covered by `QuestionToolCard.test.ts`. |
| Table | `ui/table` | `MarkdownRenderer` | Official table family. The diff grid remains a presentation-table exception; Markdown rendering is covered by `MarkdownRenderer.test.ts`. |
| Dialog | `ui/dialog` | `ThemeSettingsDialog`, `ExtensionDialog`, `ImageLightbox`, `ui/command-dialog` | Official modal lifecycle, focus, Escape, scroll lock, Portal and Overlay. `Root` accepts a semantic `dialog`/`lightbox` owner, `Content` accepts `overlayProps` for established backdrops, and floating descendants inherit a tier above that owner; covered by the feature and layer-contract tests plus rendered modal flows. |
| Alert Dialog | `ui/alert-dialog` | Registry baseline; no feature caller currently | Official registry baseline with the shared portal target. Extension confirmation stays in its single protocol-request Dialog lifecycle rather than splitting one request across modal roots. |
| Sheet | `ui/sheet` | Compact `AppRightSidebar` | Official compact-layout sidebar modal; desktop retains its persistent `<aside>`. The component-boundary test guards the Portal seam; the narrow rendered flow guards layout and exercises open/dismiss/focus whenever a right-rail tab is present. |
| Popover | `ui/popover` | `AppHeader`, `QuestionRemoteCombobox` | Official shared floating layer and `.app-shell` portal. Header and remote-selection flows retain their existing state ownership and are covered by `AppHeader.test.ts` and `QuestionToolCard.remoteSelect.test.ts`. |
| Tooltip | `ui/tooltip` | `ChatTranscript`, `SubmittedAnswerValue`, `QuestionFieldLabel` | Official provider/root/trigger/content layer and `.app-shell` portal. The shared wrapper places tooltips above ordinary dialogs so portalled help remains visible from modal content. |
| Command | `ui/command` | `CommandPalette`, `WorkspaceMentionPalette`, `QuestionRemoteCombobox` | Each `Command.Item` is the single `role="option"` interaction target. Composer-owned keyboard navigation and remote value mapping remain feature-owned; covered by `CommandPalettes.test.ts` and remote-select tests. |
| Combobox | `QuestionRemoteCombobox` over `ui/popover` + `ui/command` | `QuestionToolCard` remote-select fields | Project adapter preserves remote search, paging, cancellation and model-facing value mapping; covered by `QuestionToolCard.remoteSelect.test.ts`. |
| Date Picker | `QuestionDateField` over `ui/date-picker` + `ui/calendar` | `QuestionToolCard` date fields | Project adapter preserves configured formats and the native mobile input. Content uses the shared date-picker portal; covered by `QuestionDateField.test.ts` and form tests. |
| Toast / Sonner | `ui/sonner` + `AppNotificationToast` | `AppNotifications` | Stable IDs, replacement and dismissal use `svelte-sonner`; custom content retains Dano's alert/status semantics. Covered by `AppNotificationToast.test.ts` and notification projection tests. |
| Separator | `ui/separator` | Registry baseline; header keeps its established menu separator | Official registry dependency available to composed components. `app-header-appearance.test.ts` guards the existing 5px menu-divider spacing. |
| Input Group | `ui/input-group` | Registry baseline; no feature caller currently | Official registry dependency available to future composed controls; it does not replace the composer or dynamic-form ownership described below. |

`component-system.test.ts` enforces the feature/Bits boundary, CLI aliases and CSS entrypoint, and the shared portal target. Feature tests cover modal response/cancellation, image navigation, notification dismissal, date projection, theme selection, and the native file-preview exception. Rendered interaction and visual acceptance use the Codex in-app Browser rather than repository-owned headless-browser fixtures.

## Feature migration matrix

| Feature surface and callers | Pre-migration behavior and visual responsibility | Decision or retained exception | Automated and rendered regression seam |
| --- | --- | --- | --- |
| `App`, `AppMainContent` | Own document layout, transcript pagination, responsive shell and modal concurrency | Retain native document/layout elements; they do not duplicate a library overlay, selection, or focus primitive | App/layout tests; wide and narrow in-app Browser overflow checks |
| `AppHeader` | Own connection/menu/new-session actions, popover placement and menu spacing | Use shared `Button` and `Popover`; retain header-specific status and menu layout | `AppHeader.test.ts`, `app-header-appearance.test.ts`; rendered 5px divider, Portal, Escape and focus-return checks |
| `AppRightSidebar` | Persistent desktop rail and custom compact modal/backdrop | Use shared `Sheet` and `Button` only on compact layouts; retain native desktop `<aside>` | Component boundary test guards the shared Portal; narrow in-app Browser guards responsive overflow, with open/dismiss/focus exercised when a right-rail tab is present |
| `ThemeSettingsDialog` | Own overlay, focus/Escape/scroll lock, preset colors and established size | Shared `Dialog` owns modal behavior; retain application-specific `aria-pressed` swatch rows | `ThemeSettingsDialog.test.ts`; rendered centered size, Portal, Escape, focus and restored theme preference |
| `ExtensionDialog` | Own one protocol request across select/confirm/input/editor variants, overlay and controls | Shared `Dialog`, `Button`, `Input`, `Textarea`; retain business request/response state | `ExtensionDialog.test.ts`; rendered modal lifecycle where a request is available |
| `ImageLightbox` | Own overlay, Escape/scroll lock, image navigation and established full-screen visuals | Shared `Dialog`/`Button` own modal lifecycle; `Dialog.Root layer="lightbox"` selects the shared lightbox owner and arrow navigation remains feature-owned | `ImageLightbox.test.ts`; rendered open/navigation/dismiss flow when an image is available |
| `FilePreviewDialog`, called by `ComposerBar` and `ChatTranscript` | Own browser top layer, full-viewport/maximized sizing, image zoom/pan, text preview, body lock and localized controls | Retain native `<dialog>.showModal()`: an app-shell Portal remains inside ordinary stacking contexts and is not semantically equivalent to browser `:modal`. The dialog remains a DOM descendant of `.app-shell`, so theme variables still inherit in the top layer; its accessible name, localized controls, native cancel event and explicit trigger-focus restoration remain part of the exception. It introduces no numeric cross-feature ordering and is the sole top-layer exception to the shared ordinary-layer contract | `FilePreviewDialog.test.ts` verifies DOM ownership, modal open state, localized controls, maximize, cancel and focus restoration. In-app Browser verifies `:modal`, inherited theme variables, viewport maximization, close dismissal, scroll cleanup and trigger-focus return |
| `AppNotifications` | Own notification identity/replacement/dismiss timers and custom toast DOM | Shared Sonner owns lifecycle; `AppNotificationToast` retains visual and alert/status semantics | `AppNotificationToast.test.ts` and notification tests; rendered toast region/close check when a notification is available |
| `CommandPalette`, `WorkspaceMentionPalette`, called by `ComposerBar` | Own list filtering, highlight, keyboard selection and nested buttons | Shared `Command` owns listbox/option and pointer selection. Each Item is the sole interaction target; composer remains the focused keyboard owner | `CommandPalettes.test.ts` renders both palettes and verifies one option target plus pointer selection; `ComposerBar.test.ts` covers Arrow/Enter/Tab/Escape delegation |
| `QuestionRemoteCombobox`, called by `QuestionToolCard` | Own remote search, paging, cancellation, option mapping and custom floating list | Shared `Popover` + `Command` adapter owns floating and option semantics; remote data behavior remains local | `QuestionToolCard.remoteSelect.test.ts`; rendered open/search/select/dismiss flow when an editable remote field is available |
| `QuestionDateField`, called by `QuestionToolCard` | Own configured formatting, desktop calendar, native narrow picker and answer projection | Shared date-picker Portal/calendar adapter on desktop; retain native `date`/`datetime-local` on narrow viewports | `QuestionDateField.test.ts` and form tests; rendered open/select/dismiss flow when an editable date field is available |
| `QuestionToolCard`, `QuestionFieldLabel` | Own dynamic validation and model field mapping for radio, checkbox, select, file, time segments and text | Retain correct native form controls; use shared Tooltip/Popover/Command only where those capabilities are actually duplicated | Question-card, remote-select and date tests; rendered submitted/confirmation cards plus editable form flows |
| `ComposerBar` | Own autosize, IME, drag/drop, attachment, recording, submit/abort and continuous input focus | Retain native textarea/file input and feature actions; use public palettes and file-preview surface | `ComposerBar.test.ts`; rendered command, mention and attachment-preview flows |
| `ChatTranscript`, `ToolActivityRow`, `SessionTreeRail`, `CompatWarning` | Own disclosure, copy, navigation and transcript-specific presentation | Retain native actions; use shared Tooltip where overflow/action help needs it | Component tests; rendered transcript action and tooltip checks |
| `MarkdownRenderer` | Own sanitized Markdown and data-table presentation | Use shared `Table` for general Markdown tables | `MarkdownRenderer.test.ts`; rendered transcript table evidence |
| `DiffView` | Own virtualized side-by-side diff geometry | Retain native `role="presentation"` table because data-table semantics are not equivalent | Diff tests and rendered diff flow when available |
| `FileViewerPanel`, `HighlightedCode`, `ReconnectBanner`, `SkillInvocationCard`, `SubmittedAnswerValue` | Own content/layout/state presentation without overlay or selection primitives | Retain native content/layout; `SubmittedAnswerValue` uses shared Tooltip only for overflow | Corresponding component tests and relevant transcript/form rendered flows |

## Rendered acceptance ledger

The initial convergence and its review fixes were exercised against the built app at `http://localhost:8080` in the Codex in-app Browser:

- Wide `1440x900`: no horizontal overflow or page console warnings/errors. The header popover remains inside `.app-shell`; its menu gap is `0px`, both separator gaps are `5px`, and Escape returns focus to the Menu trigger.
- Native file preview at `1440x900`: a temporary text attachment opened as an actual `dialog:modal` with a `1440x900` top-layer rectangle while remaining under `.app-shell` for theme inheritance (`--panel` resolved). Its normal panel stayed `860x720`; maximize produced `1392x852` at the intended 24px inset. Closing removed the dialog, restored body scrolling and returned focus to the attachment-preview trigger.
- Narrow `390x844`: document width remained exactly 390px with no horizontal overflow. The theme Dialog remained inside `.app-shell`, measured `350x398` at the centered 20px horizontal inset, locked scrolling while open, and Escape dismissed it, unlocked scrolling and returned focus to the Menu trigger.

The temporary attachment was removed after acceptance, the theme preset was not changed, and the viewport override was reset after the checks.

## Layer ownership

Dialogs, alert dialogs, sheets, popovers, tooltips, selects, and date pickers Portal into `.app-shell`. This keeps runtime theme variables available after portalling. `web/src/app.css` is the single numeric definition of the shared ordinary-layer contract, in this order:

1. Center-focus overlay and focused form content
2. Base-page popovers/selects/date pickers, then base-page tooltips
3. Dialog/sheet/alert-dialog overlay and content, then floating descendants owned by that modal
4. Image-lightbox overlay and content, then floating descendants owned by the lightbox
5. Notifications
6. Native `<dialog>.showModal()` top layer, which the browser places above all ordinary stacking contexts

Shared wrappers apply these defaults. Modal roots publish their semantic owner through Svelte context, so portalled Popover, Select, DatePicker, and Tooltip content selects the corresponding owner-relative tier while remaining a DOM child of `.app-shell`. Feature components may select the named `lightbox` owner when that semantic is intrinsic to the feature, but must not assign cross-feature numeric `z-index` values. `component-system.test.ts` guards the complete numeric order and `layer-contract.test.ts` mounts the nested Dialog/Lightbox combinations.

There is intentionally no global overlay manager. Bits UI/shadcn-svelte owns each primitive's focus, dismissal, Escape and scroll-lock contract. Cross-feature concurrency remains application state owned by `App` and the bridge store.
