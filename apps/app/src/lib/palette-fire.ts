type PaletteFireActions = {
  setChatOpen: (open: boolean) => void
  setSharingOpen: (open: boolean) => void
}

export function firePaletteSkill(
  path: string,
  actions: PaletteFireActions & {
    setPendingSkillFire: (path: string) => void
  },
) {
  actions.setChatOpen(true)
  actions.setSharingOpen(false)
  actions.setPendingSkillFire(path)
}

export function firePaletteCommand(
  path: string,
  actions: PaletteFireActions & {
    setPendingCommandFire: (path: string) => void
  },
) {
  actions.setChatOpen(true)
  actions.setSharingOpen(false)
  actions.setPendingCommandFire(path)
}
