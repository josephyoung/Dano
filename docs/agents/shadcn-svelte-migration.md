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
- Preserve Dano's `--layer-*` ordering where a wrapper or feature supplies an explicit layer.
- Keep feature components free of direct `bits-ui` imports.
- Preserve existing feature visuals and interaction contracts; registry updates do not authorize a redesign.
- Run the component boundary test, targeted feature tests, `pnpm run check`, `pnpm test`, `pnpm run build`, and the relevant browser acceptance.

The initial convergence used `shadcn-svelte` 1.5.0 with the current `vega`/Lucide registry and the neutral base color.

## Public component matrix

| Capability | Public implementation | Dano adaptation and executable evidence |
| --- | --- | --- |
| Button | `ui/button` | Official variants and sizes; adopted by shared header, dialog, sheet, lightbox, and notification surfaces. |
| Input | `ui/input` | Official input; extension input uses it. Native feature inputs remain only where described below. |
| Textarea | `ui/textarea` | Official textarea; extension editor uses it. |
| Select | `ui/select` | Official Bits-backed select with `.app-shell` portal. Native question selects remain an intentional form/mobile exception. |
| Table | `ui/table` | Official table family; Markdown rendering consumes this public layer. The diff grid remains a presentation table. |
| Dialog | `ui/dialog` | Official modal lifecycle, focus, Escape, scroll lock, Portal and Overlay. `Content` additionally accepts `overlayProps` so features can retain their established backdrop. |
| Alert Dialog | `ui/alert-dialog` | Official registry baseline with the shared portal target. Extension confirmation remains in the single extension-request Dialog lifecycle rather than splitting one protocol surface across modal roots. |
| Sheet | `ui/sheet` | Official compact-layout sidebar modal. Desktop retains its persistent `<aside>`. |
| Popover | `ui/popover` | Official shared floating layer and `.app-shell` portal. |
| Tooltip | `ui/tooltip` | Official provider/root/trigger/content layer and `.app-shell` portal. |
| Command | `ui/command` | Official command semantics used by slash-command and workspace-mention palettes while their composer-owned keyboard navigation remains unchanged. |
| Combobox | `QuestionRemoteCombobox` over `ui/popover` + `ui/command` | Project adapter preserves remote search, paging, cancellation and model-facing value mapping. |
| Date Picker | `QuestionDateField` over `ui/date-picker` + `ui/calendar` | Project adapter preserves configured date formats and the native mobile input. Its content uses the shared date-picker portal. |
| Toast / Sonner | `ui/sonner` + `AppNotificationToast` | `AppNotifications` projects stable notification IDs through `svelte-sonner`; custom content retains Dano's existing visual language and alert/status semantics. |
| Separator | `ui/separator` | Official registry dependency available to composed components. |
| Input Group | `ui/input-group` | Official registry dependency available to composed components. |

`component-system.test.ts` enforces the feature/Bits boundary, CLI aliases and CSS entrypoint, and the shared portal target. Feature tests cover modal response/cancellation, image navigation, notification dismissal, date projection, theme selection, and the native file-preview exception. Rendered interaction and visual acceptance use the Codex in-app Browser rather than repository-owned headless-browser fixtures.

## Feature migration matrix

| Feature surface | Decision | Reason |
| --- | --- | --- |
| `App`, `AppMainContent` | Native document/layout elements retained | Orchestration and transcript pagination use correct native semantics and do not reproduce a library overlay, selection, or focus-management capability. |
| `AppHeader` | Shared `Button` | Header theme, connection, and new-session actions now use the public variant layer. |
| `AppRightSidebar` | Shared `Sheet` and `Button` on compact layouts; persistent native `aside` on desktop | Mobile gains the official modal/focus lifecycle without changing the established desktop rail. |
| `ThemeSettingsDialog` | Shared `Dialog`; native preset rows retained | Dialog owns focus, Escape, scroll lock and Portal. Preset rows are application-specific `aria-pressed` choices with bespoke color swatches, not generic dialog primitives. |
| `ExtensionDialog` | Shared `Dialog`, `Button`, `Input`, and `Textarea` | One protocol request lifecycle covers select, confirm, input and editor methods. |
| `ImageLightbox` | Shared `Dialog` and `Button` | Official modal lifecycle replaces local Escape/scroll-lock handling; image arrow navigation remains feature-owned. |
| `FilePreviewDialog` | Native top-layer `<dialog>` retained | Maximized file preview intentionally uses the browser top layer and `showModal()`. Moving it into the app-shell stacking context would regress its viewport and ownership contract; `FilePreviewDialog.test.ts` verifies this exception. |
| `AppNotifications` | Shared Sonner plus `AppNotificationToast` | Stable IDs, replacement and dismissal move to the maintained toast implementation while the existing content styling remains local. |
| `CommandPalette`, `WorkspaceMentionPalette` | Shared `Command` | Selection semantics and list structure use the official component. The composer remains the focused keyboard owner, so filtering/highlight state stays explicit. |
| `QuestionRemoteCombobox` | Shared `Popover` + `Command` adapter | Remote search and paging are application behavior; overlay and option semantics are public components. |
| `QuestionDateField` | Shared date-picker portal/calendar adapter; native mobile date inputs | Desktop uses the public layer. Native `date`/`datetime-local` inputs are retained on narrow devices for platform pickers and exact form-value behavior. |
| `QuestionToolCard`, `QuestionFieldLabel` | Native form controls retained | Radio, checkbox, select, file, time-segment, and text controls participate directly in dynamic form validation and model field mapping. They use correct browser semantics and do not duplicate shared modal/floating-layer behavior. |
| `ComposerBar` | Native textarea, file input, and feature action buttons retained | Autosize, IME, drag/drop, attachment, recording, submit/abort, and continuous composer focus form one tested application control. Replacing its internal nodes with styled wrappers would not add shared behavior. |
| `ChatTranscript`, `ToolActivityRow`, `SessionTreeRail`, `CompatWarning` | Native feature actions retained; shared Tooltip where applicable | These are local disclosure/copy/navigation actions with correct button/input semantics and feature-owned styling. They do not implement a second component-system primitive. |
| `MarkdownRenderer` | Shared `Table` | General Markdown table markup uses the public table family. |
| `DiffView` | Native presentation table retained | The virtualized diff grid is explicitly `role="presentation"` and follows the diff engine's layout contract rather than data-table semantics. |
| `FileViewerPanel`, `HighlightedCode`, `ReconnectBanner`, `SkillInvocationCard`, `SubmittedAnswerValue` | Native content/layout elements retained | No component-system capability is duplicated. |

## Layer ownership

Dialogs, alert dialogs, sheets, popovers, tooltips, selects, and date pickers Portal into `.app-shell`. This keeps runtime theme variables available after portalling. The wrapper supplies structure and behavior; the feature owns only its intended visual layer through existing `--layer-*` tokens or an explicit established class.

There is intentionally no global overlay manager in this migration. Bits UI/shadcn-svelte owns each primitive's focus, dismissal, Escape and scroll-lock contract. Cross-feature concurrency remains application state owned by `App` and the bridge store.
