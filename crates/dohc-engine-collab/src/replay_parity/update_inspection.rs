//! Decide, without applying it, whether a synced update could destroy content
//! its head already holds.
//!
//! The inspection scans the head's full state and the candidate's v1 wire with
//! the replay-parity scanner. It resolves each incoming block's effective
//! parent and key as yrs integration does (vendored `update.rs`,
//! `missing_dependency`, and `block.rs`, `integrate_item`): the parent is the
//! block's own, else its left origin item's, else its right origin item's; the
//! key is the left item's, else the right item's, else the block's own. Both
//! origin items must share that parent and key, as they do in every honest
//! Yjs update. A block that disagrees, a reference it cannot resolve, and a
//! head Skip a candidate could fill all hold.
//!
//! Two yrs effects pass on purpose:
//! - After a remote transaction, yrs' formatting cleanup can delete existing
//!   Format marks whose key repeats in the same gap. Those marks are
//!   redundant, so the projection does not change.
//! - A block whose origin is a later clock of its own client is admitted, but
//!   yrs parks that client's blocks as pending. Later candidates then hold on
//!   [`StructuralHold::PendingState`]. This blocks progress and destroys
//!   nothing.

use std::collections::{BTreeMap, HashMap, HashSet};

use yrs::block::{
    BLOCK_ITEM_DELETED_REF_NUMBER, BLOCK_ITEM_FORMAT_REF_NUMBER, BLOCK_ITEM_TYPE_REF_NUMBER, ID,
};
use yrs::ClientID;

use super::{
    normalize_ranges, scan_v2, BlockDescriptor, BlockKind, ParentDescriptor, WireStructure,
};
use crate::Ydoc;

/// What [`inspect_update`] decided about one candidate update.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UpdateInspection {
    Admissible,
    Hold(StructuralHold),
}

/// The condition that held a candidate, in the order they are checked.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum StructuralHold {
    /// The head holds updates or deletions it could not integrate yet, or a
    /// Skip over clocks it has not received.
    PendingState,
    /// A deletion covers a clock live in the head.
    LiveDeletion,
    /// A deletion covers a clock that is neither already deleted in the head
    /// nor part of a fresh structure this candidate safely admits.
    UnprovenDeletion,
    /// A map-keyed insertion into a parent that existed before the update.
    ExistingParentKey,
    /// A formatting control inserted into text that existed before the update.
    ExistingTextFormat,
    /// An origin or parent lands in a garbage-collected block or deleted content.
    CollectedReference,
    /// An origin or parent lands on a clock neither side holds, or a block
    /// follows a gap the head does not fill.
    UnresolvedReference,
    /// The bytes or structure cannot be classified: among others, bytes the
    /// scan rejects, such as a client's block section given twice, or a block
    /// whose origins sit in another parent or key.
    Unclassifiable,
}

/// Decide whether applying `candidate` to `head` could delete, overwrite or
/// reformat content `head` already holds. Base-state replacement, lineage and
/// binding changes are decided by the caller.
pub fn inspect_update(head: &Ydoc, candidate: &[u8]) -> UpdateInspection {
    match decide(head, candidate) {
        Ok(()) => UpdateInspection::Admissible,
        Err(reason) => UpdateInspection::Hold(reason),
    }
}

fn decide(head: &Ydoc, candidate: &[u8]) -> Result<(), StructuralHold> {
    if head.has_pending_dependencies() {
        return Err(StructuralHold::PendingState);
    }
    let known = scan_v2(&head.encode_full_state()).map_err(|_| StructuralHold::Unclassifiable)?;
    // yrs leaves a head Skip out of the clocks it knows, so a candidate block
    // filling one integrates even though the head's clock is past it.
    if known
        .blocks
        .values()
        .flatten()
        .any(|block| block.kind == BlockKind::Skip)
    {
        return Err(StructuralHold::PendingState);
    }
    let incoming = scan_v2(candidate).map_err(|_| StructuralHold::Unclassifiable)?;
    let mut index = Index::new(&known);
    let mut block_hold = None;
    let mut fresh = Vec::new();
    for (&client, blocks) in &incoming.blocks {
        let mut next = index.clock(client);
        let mut gap = false;
        for block in blocks {
            let end = block.id.clock + block.len;
            if end <= next {
                continue;
            }
            if gap || block.id.clock > next || block.kind == BlockKind::Skip {
                gap = true;
                block_hold = first(block_hold, StructuralHold::UnresolvedReference);
                continue;
            }
            fresh.push(index.push_fresh(block, next));
            next = end;
        }
    }
    // Clocks of fresh structures this candidate safely admits.
    let mut admitted: BTreeMap<ClientID, Vec<(u32, u32)>> = BTreeMap::new();
    for at in fresh {
        let range = (index.block(at).start, index.block(at).end);
        match index.admit(at) {
            Ok(()) => admitted.entry(at.0).or_default().push(range),
            Err(reason) => block_hold = first(block_hold, reason),
        }
    }
    for ranges in admitted.values_mut() {
        normalize_ranges(ranges);
    }
    let mut unproven = false;
    for (client, ranges) in &incoming.deleted_ranges {
        let historical = known
            .deleted_ranges
            .get(client)
            .map_or(&[][..], Vec::as_slice);
        let admitted = admitted.get(client).map_or(&[][..], Vec::as_slice);
        let live_end = index.clock(*client);
        for &(start, end) in ranges {
            for (start, end) in uncovered(historical, start, end) {
                if start < live_end {
                    return Err(StructuralHold::LiveDeletion);
                }
                unproven |= !uncovered(admitted, start, end).is_empty();
            }
        }
    }
    if unproven {
        return Err(StructuralHold::UnprovenDeletion);
    }
    block_hold.map_or(Ok(()), Err)
}

/// The earlier-checked of two block holds.
fn first(held: Option<StructuralHold>, reason: StructuralHold) -> Option<StructuralHold> {
    Some(held.map_or(reason, |held| held.min(reason)))
}

/// The parts of `[start, end)` that normalized `ranges` leave uncovered.
fn uncovered(ranges: &[(u32, u32)], start: u32, end: u32) -> Vec<(u32, u32)> {
    let mut gaps = Vec::new();
    let mut at = start;
    let first = ranges.partition_point(|&(_, range_end)| range_end <= start);
    for &(range_start, range_end) in &ranges[first..] {
        if range_start >= end {
            break;
        }
        if range_start > at {
            gaps.push((at, range_start));
        }
        at = at.max(range_end);
    }
    if at < end {
        gaps.push((at, end));
    }
    gaps
}

/// A block's position: its client and its index in that client's blocks.
type At = (ClientID, usize);

#[derive(Clone, Copy, PartialEq)]
struct Effective<'a> {
    parent: &'a ParentDescriptor,
    key: Option<&'a str>,
}

struct Block<'a> {
    start: u32,
    end: u32,
    kind: BlockKind,
    left_origin: Option<ID>,
    right_origin: Option<ID>,
    parent: Option<&'a ParentDescriptor>,
    parent_sub: Option<&'a str>,
    fresh: bool,
}

/// The head's blocks followed by the candidate's fresh ones, per client in
/// clock order. Skips are never indexed, so an origin in one is unresolved.
struct Index<'a> {
    clients: HashMap<ClientID, Vec<Block<'a>>>,
    known_clocks: &'a BTreeMap<ClientID, u32>,
    resolved: HashMap<At, Result<Effective<'a>, StructuralHold>>,
    admitted: HashMap<At, Result<(), StructuralHold>>,
}

impl<'a> Index<'a> {
    fn new(known: &'a WireStructure) -> Self {
        let clients = known
            .blocks
            .iter()
            .map(|(&client, blocks)| {
                let blocks = blocks
                    .iter()
                    .map(|block| Block::new(block, false))
                    .collect();
                (client, blocks)
            })
            .collect();
        Index {
            clients,
            known_clocks: &known.claimed_clocks,
            resolved: HashMap::new(),
            admitted: HashMap::new(),
        }
    }

    fn clock(&self, client: ClientID) -> u32 {
        self.known_clocks.get(&client).copied().unwrap_or(0)
    }

    /// Index the part of `block` from `from` on. Like yrs' trimming of known
    /// clocks, a part that starts inside the block takes its preceding clock as
    /// its left origin and keeps its own parent and key.
    fn push_fresh(&mut self, block: &'a BlockDescriptor, from: u32) -> At {
        let mut fresh = Block::new(block, true);
        if from > block.id.clock {
            fresh.start = from;
            fresh.left_origin = Some(ID::new(block.id.client, from - 1));
        }
        let blocks = self.clients.entry(block.id.client).or_default();
        blocks.push(fresh);
        (block.id.client, blocks.len() - 1)
    }

    fn block(&self, at: At) -> &Block<'a> {
        &self.clients[&at.0][at.1]
    }

    /// The item block holding `id`.
    fn item_at(&self, id: ID) -> Result<At, StructuralHold> {
        let blocks = self
            .clients
            .get(&id.client)
            .ok_or(StructuralHold::UnresolvedReference)?;
        let index = blocks.partition_point(|block| block.end <= id.clock);
        match blocks.get(index) {
            Some(block) if block.start <= id.clock => match block.kind {
                BlockKind::Item(_) => Ok((id.client, index)),
                BlockKind::Gc => Err(StructuralHold::CollectedReference),
                BlockKind::Skip => Err(StructuralHold::UnresolvedReference),
            },
            _ => Err(StructuralHold::UnresolvedReference),
        }
    }

    /// The items `at`'s left and right origins land in. Every origin must
    /// land in an item.
    fn neighbours(&self, at: At) -> Result<[Option<At>; 2], StructuralHold> {
        let block = self.block(at);
        let land = |origin: Option<ID>| origin.map(|id| self.item_at(id)).transpose();
        Ok([land(block.left_origin)?, land(block.right_origin)?])
    }

    /// Resolve the parent and key `at` integrates into, after both its
    /// neighbours. Walks the origins depth first with an explicit stack, so a
    /// long chain cannot overflow the call stack; an origin cycle holds.
    fn resolve(&mut self, at: At) -> Result<Effective<'a>, StructuralHold> {
        let mut stack = vec![at];
        let mut entered = HashSet::new();
        while let Some(&current) = stack.last() {
            if self.resolved.contains_key(&current) {
                stack.pop();
                continue;
            }
            let resolved = match self.neighbours(current) {
                Err(reason) => Err(reason),
                Ok(neighbours) if entered.insert(current) => {
                    let unresolved: Vec<At> = neighbours
                        .into_iter()
                        .flatten()
                        .filter(|neighbour| !self.resolved.contains_key(neighbour))
                        .collect();
                    if unresolved
                        .iter()
                        .any(|neighbour| entered.contains(neighbour))
                    {
                        Err(StructuralHold::Unclassifiable)
                    } else {
                        stack.extend(unresolved);
                        continue;
                    }
                }
                Ok([left, right]) => self.effective(current, left, right),
            };
            self.resolved.insert(current, resolved);
            stack.pop();
        }
        self.resolved[&at]
    }

    /// The parent and key yrs gives `at` beside its resolved neighbours. A
    /// neighbour in another parent or key holds: yrs would link the block
    /// beside it, or overwrite its map entry.
    fn effective(
        &self,
        at: At,
        left: Option<At>,
        right: Option<At>,
    ) -> Result<Effective<'a>, StructuralHold> {
        let resolved = |at: Option<At>| at.map(|at| self.resolved[&at]).transpose();
        let (left, right) = (resolved(left)?, resolved(right)?);
        let block = self.block(at);
        let parent = block
            .parent
            .or(left.map(|left| left.parent))
            .or(right.map(|right| right.parent))
            .ok_or(StructuralHold::Unclassifiable)?;
        let key = left
            .and_then(|left| left.key)
            .or(right.and_then(|right| right.key))
            .or(block.parent_sub);
        let effective = Effective { parent, key };
        if left.into_iter().chain(right).any(|side| side != effective) {
            return Err(StructuralHold::Unclassifiable);
        }
        Ok(effective)
    }

    /// Whether the fresh block at `at` only adds content. A block in a parent
    /// this candidate creates is admitted only with that parent. Walks the
    /// fresh parents iteratively, so deep nesting cannot overflow the stack.
    fn admit(&mut self, at: At) -> Result<(), StructuralHold> {
        let mut chain = Vec::new();
        let mut visiting = HashSet::new();
        let mut current = at;
        let admitted = loop {
            if let Some(admitted) = self.admitted.get(&current) {
                break *admitted;
            }
            if !visiting.insert(current) {
                break Err(StructuralHold::Unclassifiable);
            }
            chain.push(current);
            match self.admit_in_parent(current) {
                Ok(Some(parent)) => current = parent,
                Ok(None) => break Ok(()),
                Err(reason) => break Err(reason),
            }
        };
        for at in chain {
            self.admitted.insert(at, admitted);
        }
        admitted
    }

    /// Check the fresh block at `at` against its parent: a map-keyed or
    /// formatting insertion must go into a parent this candidate creates.
    /// Returns that fresh parent, whose own admission decides this block's.
    fn admit_in_parent(&mut self, at: At) -> Result<Option<At>, StructuralHold> {
        let BlockKind::Item(content) = self.block(at).kind else {
            return Ok(None);
        };
        let Effective { parent, key } = self.resolve(at)?;
        if let ParentDescriptor::Item(id) = parent {
            let parent_at = self.item_at(*id)?;
            let parent = self.block(parent_at);
            match parent.kind {
                BlockKind::Item(BLOCK_ITEM_TYPE_REF_NUMBER) if parent.fresh => {
                    return Ok(Some(parent_at))
                }
                BlockKind::Item(BLOCK_ITEM_TYPE_REF_NUMBER) => {}
                BlockKind::Item(BLOCK_ITEM_DELETED_REF_NUMBER) => {
                    return Err(StructuralHold::CollectedReference)
                }
                _ => return Err(StructuralHold::Unclassifiable),
            }
        }
        if key.is_some() {
            return Err(StructuralHold::ExistingParentKey);
        }
        if content == BLOCK_ITEM_FORMAT_REF_NUMBER {
            return Err(StructuralHold::ExistingTextFormat);
        }
        Ok(None)
    }
}

impl<'a> Block<'a> {
    fn new(block: &'a BlockDescriptor, fresh: bool) -> Self {
        Block {
            start: block.id.clock,
            end: block.id.clock + block.len,
            kind: block.kind,
            left_origin: block.left_origin,
            right_origin: block.right_origin,
            parent: block.parent.as_ref(),
            parent_sub: block.parent_sub.as_deref(),
            fresh,
        }
    }
}

#[cfg(test)]
mod tests;
