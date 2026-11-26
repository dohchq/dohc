//! dohc: read what a delete set removed, where it stood in the document.
//!
//! A document that keeps deleted content (`skip_gc`) still holds every deleted
//! item, its parent and its place among its siblings. Yjs reads these through
//! its item fields; here they are crate-private, so this module reads them for
//! a caller that needs to say what a merge removed.
use crate::block::{ItemContent, ItemPtr};
use crate::branch::BranchPtr;
use crate::slice::BlockSlice;
use crate::types::{TypePtr, TypeRef};
use crate::{Any, IdSet, Out, ReadTxn, ID};
use std::collections::HashMap;
use std::marker::PhantomData;

/// Every item run `set` names that the document holds, each clipped to the
/// set's ranges. Runs of garbage-collected or unknown blocks are skipped.
pub fn deleted_runs<'t, T: ReadTxn>(txn: &'t T, set: &'t IdSet) -> Vec<DeletedRun<'t>> {
    set.iter_blocks(&txn.store().blocks)
        .filter_map(|slice| match slice {
            BlockSlice::Item(slice) => Some(DeletedRun {
                item: slice.ptr,
                start: slice.start,
                end: slice.end + 1,
                txn: PhantomData,
            }),
            _ => None,
        })
        .collect()
}

/// Part of one item, as clock offsets `start..end` into it.
#[derive(Clone, Copy)]
pub struct DeletedRun<'t> {
    item: ItemPtr,
    start: u32,
    end: u32,
    txn: PhantomData<&'t ()>,
}

impl<'t> DeletedRun<'t> {
    /// The run's first ID.
    pub fn id(&self) -> ID {
        ID::new(self.item.id.client, self.item.id.clock + self.start)
    }

    /// The run's length in clocks.
    pub fn len(&self) -> u32 {
        self.end - self.start
    }

    /// This run, narrowed to clock offsets `start..end` of itself.
    pub fn narrowed(&self, start: u32, end: u32) -> Self {
        debug_assert!(start <= end && end <= self.len());
        DeletedRun {
            item: self.item,
            start: self.start + start,
            end: self.start + end,
            txn: PhantomData,
        }
    }

    /// Whether the item is a map entry, such as an attribute, not a child.
    pub fn keyed(&self) -> bool {
        self.item.parent_sub.is_some()
    }

    /// The run's characters, when the item holds text.
    pub fn text(&self) -> Option<&'t str> {
        match &self.item.content {
            ItemContent::String(text) => {
                let text: &str = text;
                let from = byte_offset(text, self.start);
                let to = byte_offset(text, self.end);
                // SAFETY: the item lives as long as the document the transaction reads.
                Some(unsafe { &*(&text[from..to] as *const str) })
            }
            _ => None,
        }
    }

    /// The embedded value, when the item holds one.
    pub fn embed(&self) -> Option<&'t Any> {
        match &self.item.content {
            // SAFETY: as in `text`.
            ItemContent::Embed(value) => Some(unsafe { &*(value as *const Any) }),
            _ => None,
        }
    }

    /// The element, when the item holds an XML element.
    pub fn element(&self) -> Option<DeletedElement<'t>> {
        match &self.item.content {
            ItemContent::Type(branch) => match branch.type_ref() {
                TypeRef::XmlElement(_) => Some(DeletedElement {
                    branch: BranchPtr::from(branch),
                    txn: PhantomData,
                }),
                _ => None,
            },
            _ => None,
        }
    }

    fn parent(&self) -> Option<BranchPtr> {
        match self.item.parent {
            TypePtr::Branch(branch) => Some(branch),
            _ => None,
        }
    }

    /// Whether the item sits in an XML text.
    pub fn in_xml_text(&self) -> bool {
        self.parent()
            .is_some_and(|parent| matches!(parent.type_ref(), TypeRef::XmlText))
    }

    /// The line the run sits in: the element holding its XML text, or its
    /// parent when it is a child of an element. `None` at the top level.
    pub fn line(&self) -> Option<ID> {
        let parent = self.parent()?;
        let line = if matches!(parent.type_ref(), TypeRef::XmlText) {
            match parent.item?.parent {
                TypePtr::Branch(branch) => branch,
                _ => return None,
            }
        } else {
            parent
        };
        line.item.map(|item| item.id)
    }

    /// Whether the item is a child of the root named `name` itself.
    pub fn in_root(&self, name: &str) -> bool {
        self.parent()
            .is_some_and(|parent| parent.item.is_none() && parent.name.as_deref() == Some(name))
    }

    /// The nearest element named `name` before the run among its siblings,
    /// deleted or not.
    pub fn element_before(&self, name: &str) -> Option<ID> {
        let mut left = self.item.left;
        while let Some(item) = left {
            if let ItemContent::Type(branch) = &item.content {
                if matches!(branch.type_ref(), TypeRef::XmlElement(tag) if tag.as_ref() == name) {
                    return Some(item.id);
                }
            }
            left = item.left;
        }
        None
    }

    /// Where the run stood: each ancestor's offset among its siblings, then
    /// the run's own. Deleted siblings count, so runs sort the way they stood.
    pub fn place(&self, places: &mut Places) -> Vec<u32> {
        let mut place = match self.parent() {
            Some(parent) => places.path(parent),
            None => Vec::new(),
        };
        place.push(places.index(self.item) + self.start);
        place
    }
}

/// A deleted XML element.
#[derive(Clone, Copy)]
pub struct DeletedElement<'t> {
    branch: BranchPtr,
    txn: PhantomData<&'t ()>,
}

impl<'t> DeletedElement<'t> {
    /// The element's name.
    pub fn name(&self) -> &'t str {
        match self.branch.type_ref() {
            // SAFETY: as in `DeletedRun::text`.
            TypeRef::XmlElement(name) => unsafe { &*(name.as_ref() as *const str) },
            _ => "",
        }
    }

    /// The last value written to an attribute, deleted or not.
    pub fn attribute(&self, key: &str) -> Option<Any> {
        match self.branch.map.get(key)?.content.get_last()? {
            Out::Any(value) => Some(value),
            _ => None,
        }
    }
}

/// Offsets already worked out, shared by the runs of one read.
#[derive(Default)]
pub struct Places {
    indexes: HashMap<ID, u32>,
    paths: HashMap<Option<ID>, Vec<u32>>,
}

impl Places {
    fn path(&mut self, branch: BranchPtr) -> Vec<u32> {
        let key = branch.item.map(|item| item.id);
        if let Some(path) = self.paths.get(&key) {
            return path.clone();
        }
        let path = match branch.item {
            Some(item) => {
                let mut path = match item.parent {
                    TypePtr::Branch(parent) => self.path(parent),
                    _ => Vec::new(),
                };
                path.push(self.index(item));
                path
            }
            None => Vec::new(),
        };
        self.paths.insert(key, path.clone());
        path
    }

    /// The item's offset among its siblings, in clocks.
    fn index(&mut self, item: ItemPtr) -> u32 {
        if let Some(index) = self.indexes.get(&item.id) {
            return *index;
        }
        // Every sibling the walk passes is kept too, so runs that arrive right
        // to left, such as typing at a line's start, walk the line once.
        let mut passed = Vec::new();
        let mut left = item.left;
        let mut offset = loop {
            let Some(sibling) = left else { break 0 };
            if let Some(known) = self.indexes.get(&sibling.id) {
                break known + sibling.len;
            }
            passed.push(sibling);
            left = sibling.left;
        };
        for sibling in passed.into_iter().rev() {
            self.indexes.insert(sibling.id, offset);
            offset += sibling.len;
        }
        self.indexes.insert(item.id, offset);
        offset
    }
}

/// The byte offset of a clock offset into an item's text. Clocks count UTF-16
/// units, as Yjs does.
fn byte_offset(text: &str, clock: u32) -> usize {
    let mut units = 0;
    for (at, character) in text.char_indices() {
        if units >= clock {
            return at;
        }
        units += character.len_utf16() as u32;
    }
    text.len()
}
