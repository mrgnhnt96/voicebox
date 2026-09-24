//! Platform permission gate for the auto-paste pipeline.
//!
//! On macOS, posting synthetic keyboard events and reading focused-UI state
//! via the AX API both require the host process to be listed under System
//! Settings → Privacy & Security → Accessibility. Without that trust,
//! `CGEventPost` silently drops events and `AXUIElementCopyAttributeValue`
//! returns an error. We surface a boolean check up front so the paste
//! pipeline can short-circuit with a clear "grant permission" message
//! instead of running through the full save → write → post → restore dance
//! with nothing to show for it.

mod ffi {
    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        /// Returns true when the current process is listed in Accessibility.
        /// No prompt side-effect.
        pub fn AXIsProcessTrusted() -> bool;
    }
}

pub fn is_trusted() -> bool {
    unsafe { ffi::AXIsProcessTrusted() }
}
