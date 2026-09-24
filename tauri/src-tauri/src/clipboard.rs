//! Snapshot / write / restore helpers around the system clipboard.
//!
//! Used by the auto-paste flow: before synthesising the paste accelerator
//! into a foreign app we need to (1) remember what the user had on the
//! clipboard, (2) stage our transcribed text, (3) paste, (4) put the
//! original contents back. Missing step 4 turns every dictation into a
//! silent clipboard-stomp.
//!
//! The snapshot walks `NSPasteboard.pasteboardItems` and
//! copies every `(UTI, data)` pair into an owned `Vec<u8>`, so restore
//! rebuilds the full multi-type payload — not just the plain-text
//! fallback. Images, styled text, file-reference lists all survive the
//! round-trip.
//!
//! Every entry point manages its own `NSAutoreleasePool` because the
//! Tauri command runtime threads don't have one by default — without it,
//! every autoreleased `NSString` / `NSData` we touch would leak for the
//! life of the process.

use objc::runtime::Object;
use objc::{class, msg_send, sel, sel_impl};

/// One full-fidelity snapshot of the general pasteboard. Hold on to the value
/// until the paste has landed, then pass it to [`restore_clipboard`].
#[derive(Debug, Clone)]
pub struct ClipboardSnapshot {
    /// Outer vec: pasteboard items. Inner: `(uti, raw bytes)` per type. We
    /// store the raw UTI string and the raw `NSData` payload so we can rebuild
    /// the item with `setData:forType:` without interpreting the contents.
    items: Vec<Vec<(String, Vec<u8>)>>,
    /// `NSPasteboard.changeCount` at the moment of capture. Incremented by AppKit
    /// on every mutation from any process, so a caller can decide whether a
    /// restore is still safe (change_count == expected) or whether someone
    /// else wrote to the clipboard in the interim and we should back off.
    change_count: i64,
}

impl ClipboardSnapshot {
    pub fn change_count(&self) -> i64 {
        self.change_count
    }

    pub fn item_count(&self) -> usize {
        self.items.len()
    }
}

type Id = *mut Object;

/// RAII wrapper so the pool drains even on early return / `?` propagation.
struct AutoreleasePool {
    pool: Id,
}

impl AutoreleasePool {
    unsafe fn new() -> Self {
        let pool: Id = msg_send![class!(NSAutoreleasePool), alloc];
        let pool: Id = msg_send![pool, init];
        Self { pool }
    }
}

impl Drop for AutoreleasePool {
    fn drop(&mut self) {
        unsafe {
            let _: () = msg_send![self.pool, drain];
        }
    }
}

/// Build an autoreleased `NSString` from a Rust `&str` without scanning for
/// interior nulls (which is what `initWithUTF8String:` would require).
unsafe fn ns_string(s: &str) -> Id {
    // NSUTF8StringEncoding = 4.
    let obj: Id = msg_send![class!(NSString), alloc];
    let obj: Id = msg_send![
        obj,
        initWithBytes: s.as_ptr()
        length: s.len()
        encoding: 4u64
    ];
    let _: () = msg_send![obj, autorelease];
    obj
}

unsafe fn ns_string_to_rust(s: Id) -> Option<String> {
    if s.is_null() {
        return None;
    }
    let bytes: *const i8 = msg_send![s, UTF8String];
    if bytes.is_null() {
        return None;
    }
    std::ffi::CStr::from_ptr(bytes)
        .to_str()
        .ok()
        .map(|x| x.to_owned())
}

unsafe fn general_pasteboard() -> Result<Id, String> {
    let pb: Id = msg_send![class!(NSPasteboard), generalPasteboard];
    if pb.is_null() {
        return Err("NSPasteboard generalPasteboard returned nil".into());
    }
    Ok(pb)
}

/// Read the pasteboard's current change count without snapshotting contents.
///
/// AppKit increments this every time any process writes to the general
/// pasteboard, so it's a cheap way to detect "did someone clobber my staged
/// text before the paste landed?".
/// A snapshot taken earlier (at dictation key-down) that still matches the
/// clipboard. Reading the clipboard makes the app that copied it render every
/// format, which can take seconds; taking it while the user speaks keeps that
/// off the wait after release. Anything copied since makes it stale.
pub fn reusable(prepared: Option<ClipboardSnapshot>, current: Option<i64>) -> Option<ClipboardSnapshot> {
    prepared.filter(|snapshot| Some(snapshot.change_count) == current)
}

pub fn current_change_count() -> Result<i64, String> {
    unsafe {
        let _pool = AutoreleasePool::new();
        let pb = general_pasteboard()?;
        let c: i64 = msg_send![pb, changeCount];
        Ok(c)
    }
}

/// Capture every item on the general pasteboard into an owned snapshot.
pub fn save_clipboard() -> Result<ClipboardSnapshot, String> {
    unsafe {
        let _pool = AutoreleasePool::new();
        let pb = general_pasteboard()?;
        let change_count: i64 = msg_send![pb, changeCount];

        let items: Id = msg_send![pb, pasteboardItems];
        if items.is_null() {
            return Ok(ClipboardSnapshot {
                items: Vec::new(),
                change_count,
            });
        }

        let count: usize = msg_send![items, count];
        let mut saved: Vec<Vec<(String, Vec<u8>)>> = Vec::with_capacity(count);

        for i in 0..count {
            let item: Id = msg_send![items, objectAtIndex: i];
            if item.is_null() {
                continue;
            }
            let types: Id = msg_send![item, types];
            if types.is_null() {
                continue;
            }
            let type_count: usize = msg_send![types, count];
            let mut pairs: Vec<(String, Vec<u8>)> = Vec::with_capacity(type_count);
            for j in 0..type_count {
                let t: Id = msg_send![types, objectAtIndex: j];
                let Some(type_str) = ns_string_to_rust(t) else {
                    continue;
                };
                let data: Id = msg_send![item, dataForType: t];
                if data.is_null() {
                    // Type advertised but no concrete data (lazy provider).
                    // Skipping is safer than trying to force it to materialise.
                    continue;
                }
                let length: usize = msg_send![data, length];
                let bytes_ptr: *const u8 = msg_send![data, bytes];
                let bytes = if bytes_ptr.is_null() || length == 0 {
                    Vec::new()
                } else {
                    std::slice::from_raw_parts(bytes_ptr, length).to_vec()
                };
                pairs.push((type_str, bytes));
            }
            saved.push(pairs);
        }

        Ok(ClipboardSnapshot {
            items: saved,
            change_count,
        })
    }
}

/// Replace the pasteboard contents with a single plain-text string. Returns
/// the post-write change count so a later restore can verify nothing else
/// touched the clipboard in between.
pub fn write_text(text: &str) -> Result<i64, String> {
    unsafe {
        let _pool = AutoreleasePool::new();
        let pb = general_pasteboard()?;
        let _new_count: i64 = msg_send![pb, clearContents];

        let ns_text = ns_string(text);
        // `public.utf8-plain-text` is the raw UTI behind `NSPasteboardTypeString`
        // and works for every text-aware paste target we care about.
        let ns_type = ns_string("public.utf8-plain-text");
        let ok: bool = msg_send![pb, setString: ns_text forType: ns_type];
        if !ok {
            return Err("NSPasteboard setString:forType: returned NO".into());
        }

        let after: i64 = msg_send![pb, changeCount];
        Ok(after)
    }
}

/// Rebuild the pasteboard from a snapshot, replacing whatever is on it now.
///
/// Does not consult the change count — callers that want safe restore should
/// compare [`current_change_count`] against the value returned by
/// [`write_text`] first.
pub fn restore_clipboard(snapshot: &ClipboardSnapshot) -> Result<(), String> {
    unsafe {
        let _pool = AutoreleasePool::new();
        let pb = general_pasteboard()?;
        let _: i64 = msg_send![pb, clearContents];

        if snapshot.items.is_empty() {
            return Ok(());
        }

        let array: Id = msg_send![class!(NSMutableArray), array];

        for pairs in &snapshot.items {
            let item: Id = msg_send![class!(NSPasteboardItem), alloc];
            let item: Id = msg_send![item, init];
            let _: () = msg_send![item, autorelease];

            for (uti, bytes) in pairs {
                let ns_type = ns_string(uti);
                let data: Id = msg_send![
                    class!(NSData),
                    dataWithBytes: bytes.as_ptr()
                    length: bytes.len()
                ];
                let _ok: bool = msg_send![item, setData: data forType: ns_type];
            }

            let _: () = msg_send![array, addObject: item];
        }

        let ok: bool = msg_send![pb, writeObjects: array];
        if !ok {
            return Err("NSPasteboard writeObjects: returned NO".into());
        }
        Ok(())
    }
}

#[cfg(test)]
mod reuse_tests {
    use super::*;

    fn snapshot(change_count: i64) -> ClipboardSnapshot {
        ClipboardSnapshot {
            items: vec![vec![("public.utf8-plain-text".to_string(), b"copied".to_vec())]],
            change_count,
        }
    }

    #[test]
    fn a_snapshot_from_key_down_is_reused_when_nothing_was_copied_since() {
        let reused = reusable(Some(snapshot(7)), Some(7)).expect("reused");
        assert_eq!(reused.change_count, 7);
    }

    #[test]
    fn copying_during_dictation_makes_the_snapshot_stale() {
        assert!(reusable(Some(snapshot(7)), Some(8)).is_none());
    }

    #[test]
    fn no_snapshot_or_unknown_clipboard_means_saving_again() {
        assert!(reusable(None, Some(7)).is_none());
        assert!(reusable(Some(snapshot(7)), None).is_none());
    }
}
