# Web CSS ownership

`main.tsx` loads tokens, the base reset, `styles.css`, then the product shell and page overrides. `styles.css` imports `ui/legacy-controls.css` and `ui/workspace-layout.css` before its remaining surface rules. This preserves the previous positions of those rule blocks in the cascade.

- `ui/forms.css` owns Button variants, sizes and focus through the base focus ring, plus Input/Select/Textarea and field labels.
- `ui/legacy-controls.css` is the fallback for existing native controls. Its Button and field-label exclusions use `:where()` so native selectors retain their previous specificity. Shared `.ui-btn` and `.ui-input` controls do not receive the legacy focus outline; their base focus ring stays visible.
- `ui/workspace-layout.css` contains the existing shell, workspace panes and shared hidden loading labels. Later responsive and product-shell rules keep their original override positions.
- Feature-specific styles stay with their existing owners, including `work-management.css`, `work-insights.css`, `resource-management.css`, `settings.css`, `conversation.css`, `channels.css` and component stylesheets.

For new form controls, use Button/Input/Select/Textarea where their semantics fit. Keep necessary native checkboxes, disclosures and custom controls. Add styles to the owning component stylesheet and use tokens; avoid increasing selector specificity to override the transitional rules. When migrating another surface, check all callers before deleting its old selectors and verify computed styles in both themes, narrow viewports, keyboard focus and disabled/error states.

This is a staged migration: remaining legacy surface rules still live in `styles.css`. Moving a rule alone does not establish a visual improvement or a loading-performance gain.
