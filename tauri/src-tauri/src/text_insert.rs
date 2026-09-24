//! Direct text insertion through the Accessibility API.
//!
//! The clipboard path in `paste_final_text` costs a clipboard save/write, an
//! 80 ms pill-hide settle, a synthetic ⌘V and a 400 ms wait before the
//! clipboard is restored. When the focused element of the target app lets us
//! set `AXSelectedText`, we can instead write the text straight into it: it
//! replaces the selection (or inserts at the caret), with no keystroke, no
//! clipboard and no sleep, so the text is on screen as soon as the call
//! returns.
//!
//! Rules this module enforces:
//!
//! - Never insert into a secure (password) field, and never into apps whose
//!   AX text is not the input (terminals): those keep the clipboard path.
//! - Only attempt when the insertion can be verified: the selection range and
//!   the character count must be readable before the attempt.
//! - After the attempt, re-read the element. Fall back to the clipboard only
//!   when the element is observably unchanged, so the text is never inserted
//!   twice. When the outcome cannot be determined, report an error instead of
//!   pasting (the text stays in Captures).
//!
//! The decisions ([`choose_strategy`], [`judge`], [`next_step`]) are pure and
//! unit-tested. The AX calls sit behind [`AxTextTarget`] so the orchestration
//! ([`insert_into`]) runs against fakes in tests.

use std::time::Duration;

/// A range in the element's text, in UTF-16 code units (what AX reports).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TextRange {
    pub location: i64,
    pub length: i64,
}

/// What the element looks like at one moment. `None` means the attribute
/// could not be read.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Observation {
    pub selection: Option<TextRange>,
    pub char_count: Option<i64>,
}

/// What the focused element supports, read before any change is made.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Capabilities {
    pub role: Option<String>,
    pub subrole: Option<String>,
    pub selected_text_settable: bool,
    pub before: Observation,
}

/// Why the clipboard path is used instead of direct insertion.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FallbackReason {
    EmptyText,
    NoFocusedElement,
    ClipboardOnlyApp,
    SecureField,
    NotATextRole,
    NotSettable,
    Unverifiable,
    /// Attempted, and the element is observably unchanged.
    NotInserted,
    UnsupportedPlatform,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Strategy {
    Accessibility,
    Clipboard(FallbackReason),
}

/// Result of comparing the element before and after the attempt.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verdict {
    /// Caret and character count moved exactly as the insertion predicts.
    Inserted,
    /// The element is observably identical to before: nothing was inserted.
    Unchanged,
    /// The element changed, but not exactly as predicted (autocorrect, a
    /// length limit, reformatting). Text landed; falling back would double it.
    ChangedUnexpectedly,
    /// Not enough could be read to tell.
    Unknown,
}

/// What to do after a verdict.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Step {
    Done,
    /// Re-read after a short wait (apps that apply the change asynchronously).
    Wait,
    Fallback,
    Abort,
}

/// Final result of an insertion attempt.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    /// Text is in the field. `exact` is false when it changed unexpectedly.
    Inserted { exact: bool },
    /// Nothing was inserted; use the clipboard path.
    UseClipboard(FallbackReason),
    /// Something may or may not have been inserted. Do not paste.
    Uncertain(String),
}

/// Roles whose `AXSelectedText` is the user's editable input.
const TEXT_ROLES: &[&str] = &["AXTextField", "AXTextArea", "AXComboBox"];

const SECURE_ROLE: &str = "AXSecureTextField";

/// Apps whose focused AX text is not where typed input goes. Terminals expose
/// their scrollback as an `AXTextArea`; input goes to the pty, not the view.
const CLIPBOARD_ONLY_BUNDLES: &[&str] = &[
    "com.apple.Terminal",
    "com.googlecode.iterm2",
    "dev.warp.Warp-Stable",
    "net.kovidgoyal.kitty",
    "com.github.wez.wezterm",
    "org.alacritty",
    "io.alacritty",
    "com.mitchellh.ghostty",
];

/// How many times to re-read an element that looks unchanged after a
/// successful set, and how long to wait between reads.
pub const VERIFY_POLLS: u32 = 3;
pub const VERIFY_POLL_INTERVAL: Duration = Duration::from_millis(15);

/// UTF-16 length of `text`, the unit AX ranges and counts use.
pub fn utf16_len(text: &str) -> i64 {
    text.encode_utf16().count() as i64
}

/// Decide whether to insert through Accessibility or use the clipboard.
pub fn choose_strategy(bundle_id: Option<&str>, text: &str, caps: &Capabilities) -> Strategy {
    let is_secure = [&caps.role, &caps.subrole]
        .iter()
        .any(|r| r.as_deref() == Some(SECURE_ROLE));
    if is_secure {
        return Strategy::Clipboard(FallbackReason::SecureField);
    }
    if text.is_empty() {
        return Strategy::Clipboard(FallbackReason::EmptyText);
    }
    if bundle_id.is_some_and(|id| CLIPBOARD_ONLY_BUNDLES.contains(&id)) {
        return Strategy::Clipboard(FallbackReason::ClipboardOnlyApp);
    }
    if !caps
        .role
        .as_deref()
        .is_some_and(|r| TEXT_ROLES.contains(&r))
    {
        return Strategy::Clipboard(FallbackReason::NotATextRole);
    }
    if !caps.selected_text_settable {
        return Strategy::Clipboard(FallbackReason::NotSettable);
    }
    if caps.before.selection.is_none() || caps.before.char_count.is_none() {
        return Strategy::Clipboard(FallbackReason::Unverifiable);
    }
    Strategy::Accessibility
}

/// Compare the element before and after inserting `inserted_utf16` units.
/// `text_matches` is whether the text now at the insertion range equals the
/// inserted text (`None` when it could not be read).
pub fn judge(
    before: &Observation,
    after: &Observation,
    inserted_utf16: i64,
    text_matches: Option<bool>,
) -> Verdict {
    let (Some(sel0), Some(count0)) = (before.selection, before.char_count) else {
        return Verdict::Unknown;
    };
    if after.selection.is_none() && after.char_count.is_none() {
        return Verdict::Unknown;
    }

    let sel_same = after.selection == Some(sel0);
    let count_same = after.char_count == Some(count0);
    if after.selection.is_some() && after.char_count.is_some() && sel_same && count_same {
        return Verdict::Unchanged;
    }

    // At least one readable attribute differs from before.
    let moved = (after.selection.is_some() && !sel_same)
        || (after.char_count.is_some() && !count_same);
    if !moved {
        return Verdict::Unknown;
    }

    let expected_sel = TextRange {
        location: sel0.location + inserted_utf16,
        length: 0,
    };
    let expected_count = count0 - sel0.length + inserted_utf16;
    let sel_ok = after.selection.is_none_or(|s| s == expected_sel);
    let count_ok = after.char_count.is_none_or(|c| c == expected_count);
    if sel_ok && count_ok && text_matches != Some(false) {
        Verdict::Inserted
    } else {
        Verdict::ChangedUnexpectedly
    }
}

/// Turn a verdict into the next step. `set_ok` is whether the AX set call
/// reported success; `polls_left` is how many re-reads remain.
pub fn next_step(verdict: Verdict, set_ok: bool, polls_left: u32) -> Step {
    match verdict {
        Verdict::Inserted | Verdict::ChangedUnexpectedly => Step::Done,
        Verdict::Unchanged if set_ok && polls_left > 0 => Step::Wait,
        Verdict::Unchanged => Step::Fallback,
        Verdict::Unknown if polls_left > 0 => Step::Wait,
        Verdict::Unknown => Step::Abort,
    }
}

/// The focused text element of the target app, as the AX calls see it.
pub trait AxTextTarget {
    fn role(&self) -> Option<String>;
    fn subrole(&self) -> Option<String>;
    fn is_selected_text_settable(&self) -> bool;
    fn observe(&self) -> Observation;
    /// Set `AXSelectedText`. `Err` carries the AX error code.
    fn set_selected_text(&self, text: &str) -> Result<(), i32>;
    fn string_for_range(&self, range: TextRange) -> Option<String>;
}

/// Read what `target` supports without changing anything.
pub fn probe<T: AxTextTarget>(target: &T) -> Capabilities {
    Capabilities {
        role: target.role(),
        subrole: target.subrole(),
        selected_text_settable: target.is_selected_text_settable(),
        before: target.observe(),
    }
}

/// Try to insert `text` into `target`, verifying the result. `sleep` is
/// called between re-reads (a real sleep in production, recorded in tests).
pub fn insert_into<T: AxTextTarget>(
    target: &T,
    bundle_id: Option<&str>,
    text: &str,
    mut sleep: impl FnMut(Duration),
) -> Outcome {
    let caps = probe(target);
    if let Strategy::Clipboard(reason) = choose_strategy(bundle_id, text, &caps) {
        return Outcome::UseClipboard(reason);
    }
    let before = caps.before;
    let Some(sel0) = before.selection else {
        return Outcome::UseClipboard(FallbackReason::Unverifiable);
    };
    let inserted = utf16_len(text);
    let inserted_at = TextRange {
        location: sel0.location,
        length: inserted,
    };

    let set_result = target.set_selected_text(text);
    let set_ok = set_result.is_ok();

    let mut polls_left = VERIFY_POLLS;
    loop {
        let after = target.observe();
        let mut verdict = judge(&before, &after, inserted, None);
        if verdict == Verdict::Inserted {
            // Shape matches; check the characters too (only affects `exact`).
            let matches = target.string_for_range(inserted_at).map(|s| s == text);
            verdict = judge(&before, &after, inserted, matches);
        }
        match next_step(verdict, set_ok, polls_left) {
            Step::Done => {
                return Outcome::Inserted {
                    exact: verdict == Verdict::Inserted,
                }
            }
            Step::Fallback => return Outcome::UseClipboard(FallbackReason::NotInserted),
            Step::Abort => {
                return Outcome::Uncertain(format!(
                    "Could not confirm the dictated text was inserted (AX set: {set_result:?}). \
                     It was not pasted again; copy it from Captures if it is missing."
                ))
            }
            Step::Wait => {
                polls_left -= 1;
                sleep(VERIFY_POLL_INTERVAL);
            }
        }
    }
}

/// Insert `text` into the focused element of the app with `pid`, verifying
/// the result. Blocking: every step is a synchronous AX message to the target.
pub fn insert_focused(pid: i32, bundle_id: Option<&str>, text: &str) -> Outcome {
    #[cfg(target_os = "macos")]
    {
        match macos::FocusedElement::of_app(pid) {
            Some(element) => insert_into(&element, bundle_id, text, std::thread::sleep),
            None => Outcome::UseClipboard(FallbackReason::NoFocusedElement),
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (pid, bundle_id, text);
        Outcome::UseClipboard(FallbackReason::UnsupportedPlatform)
    }
}

/// [`insert_focused`] off the async runtime, with a log line saying which
/// path was taken and how long the decision took.
pub async fn try_insert(pid: i32, bundle_id: Option<String>, text: String) -> Outcome {
    if cfg!(not(target_os = "macos")) {
        return Outcome::UseClipboard(FallbackReason::UnsupportedPlatform);
    }
    let started = std::time::Instant::now();
    let app = bundle_id.clone().unwrap_or_else(|| format!("pid {pid}"));
    let outcome =
        tokio::task::spawn_blocking(move || insert_focused(pid, bundle_id.as_deref(), &text))
            .await
            .unwrap_or_else(|e| {
                // A panic mid-attempt: we cannot know whether the set happened.
                Outcome::Uncertain(format!(
                    "Text insertion stopped unexpectedly ({e}). It was not pasted again; \
                     copy it from Captures if it is missing."
                ))
            });
    eprintln!(
        "[voicebox] text insert into {app}: {outcome:?} in {} ms",
        started.elapsed().as_millis()
    );
    outcome
}

/// The Accessibility-backed [`AxTextTarget`]: the target app's
/// `AXFocusedUIElement`.
#[cfg(target_os = "macos")]
mod macos {
    use super::{AxTextTarget, Observation, TextRange};
    use crate::focus_capture::{cf_string_const, cfstring_to_rust};
    use core_foundation_sys::base::{
        kCFAllocatorDefault, Boolean, CFGetTypeID, CFIndex, CFRange, CFRelease, CFTypeID,
        CFTypeRef,
    };
    use core_foundation_sys::number::{
        kCFNumberSInt64Type, CFNumberGetTypeID, CFNumberGetValue, CFNumberRef,
    };
    use core_foundation_sys::string::{
        kCFStringEncodingUTF8, CFStringCreateWithBytes, CFStringGetLength, CFStringGetTypeID,
        CFStringRef,
    };
    use std::ffi::c_void;
    use std::ptr;

    type AXUIElementRef = CFTypeRef;
    type AXError = i32;
    const AX_SUCCESS: AXError = 0;
    /// `kAXValueTypeCFRange`.
    const AX_VALUE_CF_RANGE: u32 = 4;
    /// Upper bound on one AX round trip to the target. The default is about
    /// 6 s; a hung target should fail over quickly instead.
    const AX_TIMEOUT_SECS: f32 = 0.25;

    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        fn AXUIElementCreateApplication(pid: i32) -> AXUIElementRef;
        fn AXUIElementGetTypeID() -> CFTypeID;
        fn AXUIElementSetMessagingTimeout(element: AXUIElementRef, timeout: f32) -> AXError;
        fn AXUIElementCopyAttributeValue(
            element: AXUIElementRef,
            attribute: CFStringRef,
            value: *mut CFTypeRef,
        ) -> AXError;
        fn AXUIElementIsAttributeSettable(
            element: AXUIElementRef,
            attribute: CFStringRef,
            settable: *mut Boolean,
        ) -> AXError;
        fn AXUIElementSetAttributeValue(
            element: AXUIElementRef,
            attribute: CFStringRef,
            value: CFTypeRef,
        ) -> AXError;
        fn AXUIElementCopyParameterizedAttributeValue(
            element: AXUIElementRef,
            attribute: CFStringRef,
            parameter: CFTypeRef,
            result: *mut CFTypeRef,
        ) -> AXError;
        fn AXValueCreate(value_type: u32, value: *const c_void) -> CFTypeRef;
        fn AXValueGetTypeID() -> CFTypeID;
        fn AXValueGetValue(value: CFTypeRef, value_type: u32, out: *mut c_void) -> Boolean;
    }

    /// An owned (+1) Core Foundation reference, released on drop.
    struct Cf(CFTypeRef);

    impl Drop for Cf {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe { CFRelease(self.0) }
            }
        }
    }

    fn key(name: &str) -> Option<Cf> {
        unsafe { cf_string_const(name).map(|s| Cf(s as CFTypeRef)) }
    }

    fn copy_attr(element: AXUIElementRef, name: &str) -> Option<Cf> {
        let key = key(name)?;
        let mut out: CFTypeRef = ptr::null();
        let err =
            unsafe { AXUIElementCopyAttributeValue(element, key.0 as CFStringRef, &mut out) };
        if err != AX_SUCCESS || out.is_null() {
            return None;
        }
        Some(Cf(out))
    }

    fn is_type(value: &Cf, type_id: CFTypeID) -> bool {
        unsafe { CFGetTypeID(value.0) == type_id }
    }

    fn as_string(value: &Cf) -> Option<String> {
        if !is_type(value, unsafe { CFStringGetTypeID() }) {
            return None;
        }
        unsafe { cfstring_to_rust(value.0 as CFStringRef) }
    }

    fn as_range(value: &Cf) -> Option<TextRange> {
        if !is_type(value, unsafe { AXValueGetTypeID() }) {
            return None;
        }
        let mut range = CFRange {
            location: 0,
            length: 0,
        };
        let ok = unsafe {
            AXValueGetValue(
                value.0,
                AX_VALUE_CF_RANGE,
                &mut range as *mut CFRange as *mut c_void,
            )
        };
        (ok != 0).then_some(TextRange {
            location: range.location as i64,
            length: range.length as i64,
        })
    }

    fn as_i64(value: &Cf) -> Option<i64> {
        if !is_type(value, unsafe { CFNumberGetTypeID() }) {
            return None;
        }
        let mut n: i64 = 0;
        let ok = unsafe {
            CFNumberGetValue(
                value.0 as CFNumberRef,
                kCFNumberSInt64Type,
                &mut n as *mut i64 as *mut c_void,
            )
        };
        ok.then_some(n)
    }

    /// UTF-16 length of a CFString value (the unit AX counts in).
    fn string_len(value: &Cf) -> Option<i64> {
        if !is_type(value, unsafe { CFStringGetTypeID() }) {
            return None;
        }
        Some(unsafe { CFStringGetLength(value.0 as CFStringRef) } as i64)
    }

    fn cf_string(text: &str) -> Option<Cf> {
        let s = unsafe {
            CFStringCreateWithBytes(
                kCFAllocatorDefault,
                text.as_ptr(),
                text.len() as CFIndex,
                kCFStringEncodingUTF8,
                0,
            )
        };
        (!s.is_null()).then(|| Cf(s as CFTypeRef))
    }

    pub struct FocusedElement {
        element: Cf,
    }

    impl FocusedElement {
        /// The focused element of the app with `pid`, if it exposes one.
        /// Asking the app (not the system-wide element) means the Voicebox
        /// pill holding key focus cannot redirect the insertion.
        pub fn of_app(pid: i32) -> Option<Self> {
            let app = unsafe { AXUIElementCreateApplication(pid) };
            if app.is_null() {
                return None;
            }
            let app = Cf(app);
            unsafe { AXUIElementSetMessagingTimeout(app.0, AX_TIMEOUT_SECS) };
            let element = copy_attr(app.0, "AXFocusedUIElement")?;
            if !is_type(&element, unsafe { AXUIElementGetTypeID() }) {
                return None;
            }
            unsafe { AXUIElementSetMessagingTimeout(element.0, AX_TIMEOUT_SECS) };
            Some(Self { element })
        }

        fn string_attr(&self, name: &str) -> Option<String> {
            copy_attr(self.element.0, name).as_ref().and_then(as_string)
        }
    }

    impl AxTextTarget for FocusedElement {
        fn role(&self) -> Option<String> {
            self.string_attr("AXRole")
        }

        fn subrole(&self) -> Option<String> {
            self.string_attr("AXSubrole")
        }

        fn is_selected_text_settable(&self) -> bool {
            let Some(key) = key("AXSelectedText") else {
                return false;
            };
            let mut settable: Boolean = 0;
            let err = unsafe {
                AXUIElementIsAttributeSettable(
                    self.element.0,
                    key.0 as CFStringRef,
                    &mut settable,
                )
            };
            err == AX_SUCCESS && settable != 0
        }

        fn observe(&self) -> Observation {
            let selection = copy_attr(self.element.0, "AXSelectedTextRange")
                .as_ref()
                .and_then(as_range);
            let char_count = copy_attr(self.element.0, "AXNumberOfCharacters")
                .as_ref()
                .and_then(as_i64)
                .or_else(|| {
                    copy_attr(self.element.0, "AXValue")
                        .as_ref()
                        .and_then(string_len)
                });
            Observation {
                selection,
                char_count,
            }
        }

        fn set_selected_text(&self, text: &str) -> Result<(), i32> {
            let key = key("AXSelectedText").ok_or(-1)?;
            let value = cf_string(text).ok_or(-1)?;
            let err = unsafe {
                AXUIElementSetAttributeValue(self.element.0, key.0 as CFStringRef, value.0)
            };
            if err == AX_SUCCESS {
                Ok(())
            } else {
                Err(err)
            }
        }

        fn string_for_range(&self, range: TextRange) -> Option<String> {
            let key = key("AXStringForRange")?;
            let cf_range = CFRange {
                location: range.location as CFIndex,
                length: range.length as CFIndex,
            };
            let param = unsafe {
                AXValueCreate(
                    AX_VALUE_CF_RANGE,
                    &cf_range as *const CFRange as *const c_void,
                )
            };
            if param.is_null() {
                return None;
            }
            let param = Cf(param);
            let mut out: CFTypeRef = ptr::null();
            let err = unsafe {
                AXUIElementCopyParameterizedAttributeValue(
                    self.element.0,
                    key.0 as CFStringRef,
                    param.0,
                    &mut out,
                )
            };
            if err != AX_SUCCESS || out.is_null() {
                return None;
            }
            as_string(&Cf(out))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::{Cell, RefCell};

    fn range(location: i64, length: i64) -> TextRange {
        TextRange { location, length }
    }

    fn obs(sel: Option<(i64, i64)>, count: Option<i64>) -> Observation {
        Observation {
            selection: sel.map(|(l, n)| range(l, n)),
            char_count: count,
        }
    }

    fn text_area(before: Observation) -> Capabilities {
        Capabilities {
            role: Some("AXTextArea".into()),
            subrole: None,
            selected_text_settable: true,
            before,
        }
    }

    // ---- choose_strategy ----

    #[test]
    fn settable_text_area_with_readable_state_uses_accessibility() {
        let caps = text_area(obs(Some((3, 0)), Some(10)));
        assert_eq!(
            choose_strategy(Some("com.apple.TextEdit"), "hi", &caps),
            Strategy::Accessibility
        );
    }

    #[test]
    fn text_field_and_combo_box_are_text_roles() {
        for role in ["AXTextField", "AXComboBox"] {
            let mut caps = text_area(obs(Some((0, 0)), Some(0)));
            caps.role = Some(role.into());
            assert_eq!(choose_strategy(None, "hi", &caps), Strategy::Accessibility, "{role}");
        }
    }

    #[test]
    fn secure_subrole_never_uses_accessibility() {
        let mut caps = text_area(obs(Some((0, 0)), Some(0)));
        caps.role = Some("AXTextField".into());
        caps.subrole = Some("AXSecureTextField".into());
        assert_eq!(
            choose_strategy(None, "hunter2", &caps),
            Strategy::Clipboard(FallbackReason::SecureField)
        );
    }

    #[test]
    fn secure_role_never_uses_accessibility() {
        let mut caps = text_area(obs(Some((0, 0)), Some(0)));
        caps.role = Some("AXSecureTextField".into());
        assert_eq!(
            choose_strategy(None, "hunter2", &caps),
            Strategy::Clipboard(FallbackReason::SecureField)
        );
    }

    #[test]
    fn secure_check_wins_over_everything_else() {
        let caps = Capabilities {
            role: Some("AXSecureTextField".into()),
            subrole: None,
            selected_text_settable: false,
            before: Observation::default(),
        };
        assert_eq!(
            choose_strategy(Some("com.apple.Terminal"), "x", &caps),
            Strategy::Clipboard(FallbackReason::SecureField)
        );
    }

    #[test]
    fn terminals_use_clipboard() {
        let caps = text_area(obs(Some((0, 0)), Some(0)));
        for id in ["com.apple.Terminal", "com.googlecode.iterm2", "com.mitchellh.ghostty"] {
            assert_eq!(
                choose_strategy(Some(id), "ls", &caps),
                Strategy::Clipboard(FallbackReason::ClipboardOnlyApp),
                "{id}"
            );
        }
    }

    #[test]
    fn non_text_role_uses_clipboard() {
        for role in [Some("AXWebArea"), Some("AXButton"), None] {
            let mut caps = text_area(obs(Some((0, 0)), Some(0)));
            caps.role = role.map(Into::into);
            assert_eq!(
                choose_strategy(None, "hi", &caps),
                Strategy::Clipboard(FallbackReason::NotATextRole),
                "{role:?}"
            );
        }
    }

    #[test]
    fn unsettable_selected_text_uses_clipboard() {
        let mut caps = text_area(obs(Some((0, 0)), Some(0)));
        caps.selected_text_settable = false;
        assert_eq!(
            choose_strategy(None, "hi", &caps),
            Strategy::Clipboard(FallbackReason::NotSettable)
        );
    }

    #[test]
    fn unreadable_selection_or_count_is_unverifiable() {
        for before in [obs(None, Some(5)), obs(Some((0, 0)), None), obs(None, None)] {
            let caps = text_area(before);
            assert_eq!(
                choose_strategy(None, "hi", &caps),
                Strategy::Clipboard(FallbackReason::Unverifiable),
                "{before:?}"
            );
        }
    }

    #[test]
    fn empty_text_uses_clipboard_path() {
        let caps = text_area(obs(Some((0, 0)), Some(0)));
        assert_eq!(
            choose_strategy(None, "", &caps),
            Strategy::Clipboard(FallbackReason::EmptyText)
        );
    }

    // ---- judge ----

    #[test]
    fn caret_and_count_as_predicted_is_inserted() {
        let before = obs(Some((3, 0)), Some(10));
        let after = obs(Some((5, 0)), Some(12));
        assert_eq!(judge(&before, &after, 2, Some(true)), Verdict::Inserted);
    }

    #[test]
    fn replacing_a_selection_is_inserted() {
        // "hello [world]" with "world" (5) selected, replaced by "there!" (6).
        let before = obs(Some((6, 5)), Some(11));
        let after = obs(Some((12, 0)), Some(12));
        assert_eq!(judge(&before, &after, 6, Some(true)), Verdict::Inserted);
    }

    #[test]
    fn replacing_selection_with_same_length_text_is_inserted_by_caret() {
        let before = obs(Some((0, 4)), Some(4));
        let after = obs(Some((4, 0)), Some(4));
        assert_eq!(judge(&before, &after, 4, None), Verdict::Inserted);
    }

    #[test]
    fn identical_state_is_unchanged() {
        let before = obs(Some((3, 0)), Some(10));
        assert_eq!(judge(&before, &before, 2, Some(false)), Verdict::Unchanged);
    }

    #[test]
    fn identical_state_is_unchanged_even_if_following_text_matches() {
        // Caret sits before an existing copy of the same words.
        let before = obs(Some((3, 0)), Some(10));
        assert_eq!(judge(&before, &before, 2, Some(true)), Verdict::Unchanged);
    }

    #[test]
    fn predicted_shape_but_different_text_is_changed_unexpectedly() {
        // Smart quotes: same length, different characters.
        let before = obs(Some((0, 0)), Some(0));
        let after = obs(Some((5, 0)), Some(5));
        assert_eq!(
            judge(&before, &after, 5, Some(false)),
            Verdict::ChangedUnexpectedly
        );
    }

    #[test]
    fn truncated_by_length_limit_is_changed_unexpectedly() {
        let before = obs(Some((0, 0)), Some(0));
        let after = obs(Some((3, 0)), Some(3));
        assert_eq!(judge(&before, &after, 10, None), Verdict::ChangedUnexpectedly);
    }

    #[test]
    fn caret_left_in_place_but_count_grew_is_changed_unexpectedly() {
        let before = obs(Some((0, 0)), Some(0));
        let after = obs(Some((0, 0)), Some(5));
        assert_eq!(judge(&before, &after, 5, None), Verdict::ChangedUnexpectedly);
    }

    #[test]
    fn unreadable_after_is_unknown() {
        let before = obs(Some((0, 0)), Some(0));
        assert_eq!(judge(&before, &obs(None, None), 5, None), Verdict::Unknown);
    }

    #[test]
    fn partially_readable_after_that_looks_unchanged_is_unknown() {
        // Count unchanged but selection unreadable: cannot prove nothing landed.
        let before = obs(Some((0, 0)), Some(0));
        assert_eq!(judge(&before, &obs(None, Some(0)), 5, None), Verdict::Unknown);
    }

    #[test]
    fn partially_readable_after_matching_prediction_is_inserted() {
        let before = obs(Some((0, 0)), Some(0));
        assert_eq!(
            judge(&before, &obs(None, Some(5)), 5, Some(true)),
            Verdict::Inserted
        );
        assert_eq!(
            judge(&before, &obs(Some((5, 0)), None), 5, Some(true)),
            Verdict::Inserted
        );
    }

    #[test]
    fn unreadable_before_is_unknown() {
        let after = obs(Some((5, 0)), Some(5));
        assert_eq!(judge(&obs(None, None), &after, 5, None), Verdict::Unknown);
    }

    // ---- next_step ----

    #[test]
    fn inserted_and_changed_are_done() {
        for v in [Verdict::Inserted, Verdict::ChangedUnexpectedly] {
            for set_ok in [true, false] {
                assert_eq!(next_step(v, set_ok, 3), Step::Done);
                assert_eq!(next_step(v, set_ok, 0), Step::Done);
            }
        }
    }

    #[test]
    fn unchanged_after_rejected_set_falls_back_immediately() {
        assert_eq!(next_step(Verdict::Unchanged, false, 3), Step::Fallback);
    }

    #[test]
    fn unchanged_after_accepted_set_waits_then_falls_back() {
        assert_eq!(next_step(Verdict::Unchanged, true, 2), Step::Wait);
        assert_eq!(next_step(Verdict::Unchanged, true, 0), Step::Fallback);
    }

    #[test]
    fn unknown_waits_then_aborts_never_falls_back() {
        for set_ok in [true, false] {
            assert_eq!(next_step(Verdict::Unknown, set_ok, 1), Step::Wait);
            assert_eq!(next_step(Verdict::Unknown, set_ok, 0), Step::Abort);
        }
    }

    // ---- insert_into with a fake element ----

    /// A fake text field holding UTF-16 text and a selection. Behaviour knobs
    /// model real-app quirks.
    struct FakeField {
        role: Option<String>,
        subrole: Option<String>,
        settable: bool,
        text: RefCell<Vec<u16>>,
        sel: Cell<TextRange>,
        /// What the set call returns.
        set_result: Result<(), i32>,
        /// Whether the set actually changes the text.
        applies: bool,
        /// Number of observations after the set before the change shows.
        apply_delay_reads: Cell<u32>,
        pending: RefCell<Option<String>>,
        /// Reads return nothing after the set (app went unresponsive).
        blind_after_set: bool,
        set_calls: Cell<u32>,
    }

    impl FakeField {
        fn new(text: &str, sel: TextRange) -> Self {
            Self {
                role: Some("AXTextArea".into()),
                subrole: None,
                settable: true,
                text: RefCell::new(text.encode_utf16().collect()),
                sel: Cell::new(sel),
                set_result: Ok(()),
                applies: true,
                apply_delay_reads: Cell::new(0),
                pending: RefCell::new(None),
                blind_after_set: false,
                set_calls: Cell::new(0),
            }
        }

        fn contents(&self) -> String {
            String::from_utf16(&self.text.borrow()).unwrap()
        }

        fn apply(&self, text: &str) {
            let sel = self.sel.get();
            let new: Vec<u16> = text.encode_utf16().collect();
            let start = sel.location as usize;
            let end = start + sel.length as usize;
            self.text.borrow_mut().splice(start..end, new.iter().copied());
            self.sel.set(range(sel.location + new.len() as i64, 0));
        }
    }

    impl AxTextTarget for FakeField {
        fn role(&self) -> Option<String> {
            self.role.clone()
        }
        fn subrole(&self) -> Option<String> {
            self.subrole.clone()
        }
        fn is_selected_text_settable(&self) -> bool {
            self.settable
        }
        fn observe(&self) -> Observation {
            if self.set_calls.get() > 0 && self.blind_after_set {
                return Observation::default();
            }
            let pending = self.pending.borrow().clone();
            if let Some(t) = pending {
                let left = self.apply_delay_reads.get();
                if left == 0 {
                    self.pending.borrow_mut().take();
                    self.apply(&t);
                } else {
                    self.apply_delay_reads.set(left - 1);
                }
            }
            Observation {
                selection: Some(self.sel.get()),
                char_count: Some(self.text.borrow().len() as i64),
            }
        }
        fn set_selected_text(&self, text: &str) -> Result<(), i32> {
            self.set_calls.set(self.set_calls.get() + 1);
            if self.applies {
                if self.apply_delay_reads.get() == 0 {
                    self.apply(text);
                } else {
                    *self.pending.borrow_mut() = Some(text.to_string());
                }
            }
            self.set_result
        }
        fn string_for_range(&self, r: TextRange) -> Option<String> {
            let t = self.text.borrow();
            let start = r.location as usize;
            let end = start + r.length as usize;
            t.get(start..end).map(|s| String::from_utf16(s).unwrap())
        }
    }

    fn run(field: &FakeField, bundle: Option<&str>, text: &str) -> (Outcome, Vec<Duration>) {
        let mut sleeps = Vec::new();
        let out = insert_into(field, bundle, text, |d| sleeps.push(d));
        (out, sleeps)
    }

    #[test]
    fn inserts_at_caret_without_waiting() {
        let field = FakeField::new("Hello world", range(5, 0));
        let (out, sleeps) = run(&field, Some("com.apple.TextEdit"), ", dear");
        assert_eq!(out, Outcome::Inserted { exact: true });
        assert_eq!(field.contents(), "Hello, dear world");
        assert!(sleeps.is_empty());
        assert_eq!(field.set_calls.get(), 1);
    }

    #[test]
    fn replaces_selection() {
        let field = FakeField::new("Hello world", range(6, 5));
        let (out, _) = run(&field, None, "there");
        assert_eq!(out, Outcome::Inserted { exact: true });
        assert_eq!(field.contents(), "Hello there");
    }

    #[test]
    fn counts_emoji_in_utf16_units() {
        let field = FakeField::new("ab", range(1, 0));
        let (out, _) = run(&field, None, "👍 ok");
        assert_eq!(out, Outcome::Inserted { exact: true });
        assert_eq!(field.contents(), "a👍 okb");
    }

    #[test]
    fn secure_field_is_never_touched() {
        let mut field = FakeField::new("", range(0, 0));
        field.subrole = Some("AXSecureTextField".into());
        let (out, _) = run(&field, None, "secret");
        assert_eq!(out, Outcome::UseClipboard(FallbackReason::SecureField));
        assert_eq!(field.set_calls.get(), 0);
    }

    #[test]
    fn unsettable_field_is_never_touched() {
        let mut field = FakeField::new("", range(0, 0));
        field.settable = false;
        let (out, _) = run(&field, None, "x");
        assert_eq!(out, Outcome::UseClipboard(FallbackReason::NotSettable));
        assert_eq!(field.set_calls.get(), 0);
    }

    #[test]
    fn rejected_set_with_no_change_falls_back_without_waiting() {
        let mut field = FakeField::new("abc", range(3, 0));
        field.applies = false;
        field.set_result = Err(-25205);
        let (out, sleeps) = run(&field, None, "x");
        assert_eq!(out, Outcome::UseClipboard(FallbackReason::NotInserted));
        assert!(sleeps.is_empty());
    }

    #[test]
    fn accepted_set_that_never_lands_falls_back_after_polls() {
        // An app that says yes but ignores the write.
        let mut field = FakeField::new("abc", range(3, 0));
        field.applies = false;
        let (out, sleeps) = run(&field, None, "x");
        assert_eq!(out, Outcome::UseClipboard(FallbackReason::NotInserted));
        assert_eq!(sleeps, vec![VERIFY_POLL_INTERVAL; VERIFY_POLLS as usize]);
        assert_eq!(field.contents(), "abc");
    }

    #[test]
    fn late_applying_app_is_detected_and_not_pasted_twice() {
        let field = FakeField::new("abc", range(3, 0));
        field.apply_delay_reads.set(2);
        let (out, sleeps) = run(&field, None, "de");
        assert_eq!(out, Outcome::Inserted { exact: true });
        assert_eq!(field.contents(), "abcde");
        assert_eq!(sleeps.len(), 2);
    }

    #[test]
    fn rejected_set_that_still_landed_is_not_pasted_twice() {
        let mut field = FakeField::new("abc", range(3, 0));
        field.set_result = Err(-25204);
        let (out, _) = run(&field, None, "de");
        assert_eq!(out, Outcome::Inserted { exact: true });
    }

    #[test]
    fn unreadable_after_set_is_uncertain_not_fallback() {
        let mut field = FakeField::new("abc", range(3, 0));
        field.blind_after_set = true;
        let (out, sleeps) = run(&field, None, "de");
        assert!(matches!(out, Outcome::Uncertain(_)), "{out:?}");
        assert_eq!(sleeps.len(), VERIFY_POLLS as usize);
    }

    #[test]
    fn terminal_is_never_touched() {
        let field = FakeField::new("$ ", range(2, 0));
        let (out, _) = run(&field, Some("com.apple.Terminal"), "ls");
        assert_eq!(out, Outcome::UseClipboard(FallbackReason::ClipboardOnlyApp));
        assert_eq!(field.set_calls.get(), 0);
    }
}
