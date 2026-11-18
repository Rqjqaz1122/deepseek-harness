/**
 * Workspace pick/add flow. WorkspacePickFlow is the reusable core (menu +
 * creation dialog) consumed directly by WorkspaceBrowser (same package) and
 * wrapped by WorkspacePicker for the conversation empty-state slot
 * registration. The creation dialog stages the name and folders before one
 * Host registration; directory picking stays in the composed flow package.
 */
import type { WorkspaceCreateRequest } from '@deepseek-ai/dsh-api-workspace-controller/types'
import type { ReactNode, RefObject } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  IconFolderCloseRegular, IconPlusOutlineRegular, Menu, type MenuEntry,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  WorkspaceId, WorkspaceSnapshot, WorkspaceView,
} from '@deepseek-ai/dsh-api-workspace-controller/client'
import { workspaceDisplayTitle } from '@deepseek-ai/dsh-api-workspace-controller/default-workspace'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import type { DirectoryFlowOwnerProps, WorkspacePickerProps } from './contract/slots.ts'
import { distinguishingPathSuffixes } from './path-suffix.ts'
import css from './WorkspacePicker.module.css'
import { WorkspaceCreateDialog } from './WorkspaceCreateDialog.tsx'

const ADD_WORKSPACE = '::add-workspace'

/** Core flow props: the owner supplies popover control and pick semantics. */
export interface WorkspacePickFlowProps {
  /** The standard locale seat, forwarded by whichever slot entry hosts the flow. */
  t: WorkspacePickerProps['t']
  /** Popover visibility (anchor button toggle state, owner-local). */
  open: boolean
  /** The anchor button element — the popover's placement anchor. */
  anchorRef?: RefObject<HTMLElement | null> | undefined
  /** Selector hook over the workspace list (framework standard hook). */
  useWorkspaces: <S>(selector: (state: WorkspaceSnapshot) => S) => S
  /** Adopt a picked host directory as a real Workspace. */
  createWorkspace: (input: WorkspaceCreateRequest) => Promise<WorkspaceView>
  /** Bound occupancy selector hook for this surface's directory-flow hole (empty leaves the surface with no add action). */
  useDirectoryFlow: SnapshotSelectorHook<boolean>
  /** Render this surface's directory-flow hole with the owner conversation (the entry's narrowed renderSlot). */
  renderDirectoryFlow: (owner: DirectoryFlowOwnerProps) => ReactNode
  /** A real Workspace was picked or created. */
  onPick: (workspaceId: WorkspaceId) => void
  /** Close the popover (outside click / Escape / post-pick). */
  onClose: () => void
  /** Report the picking interaction and adoption occupancy. */
  onBusyChange?: (busy: boolean) => void
  /** Only offer the add action, hide existing workspaces. */
  addOnly?: boolean
  /** Menu opening direction relative to the anchor. */
  side?: 'bottom' | 'top' | 'right'
  /** Currently active workspace (trailing check in the picker list). */
  selectedId?: WorkspaceId | undefined
}

/**
 * Render the pick menu plus the adoption error dialog.
 * @param props - owner-controlled flow props.
 * @returns menu + dialog elements.
 */
export function WorkspacePickFlow({
  t,
  open,
  anchorRef,
  useWorkspaces,
  createWorkspace,
  useDirectoryFlow,
  renderDirectoryFlow,
  onPick,
  onClose,
  addOnly = false,
  onBusyChange,
  side = 'bottom',
  selectedId,
}: WorkspacePickFlowProps) {
  // Without an owner-provided anchor, the menu remains hidden.
  const absentAnchor = useRef<HTMLElement>(null)
  const workspaceSnapshot = useWorkspaces(state => state)
  const workspaces = workspaceSnapshot.items
  const [creating, setCreating] = useState(false)
  const flowBusy = creating
  useEffect(() => { onBusyChange?.(flowBusy) }, [flowBusy, onBusyChange])
  const flowAvailable = useDirectoryFlow(occupied => occupied)
  const addEntries: MenuEntry[] = flowAvailable
    ? [{ id: ADD_WORKSPACE, label: t('menu.addWorkspace'), icon: <IconPlusOutlineRegular size={16} />, disabled: flowBusy }]
    : []
  // With workspaces listed, the add action pins below the scroll region
  // (divider + always visible); otherwise it IS the menu.
  const pinAdd = !addOnly && workspaces.length > 0
  // The resolved name, not `t`, is the memo dependency: the bound seat keeps
  // its identity across a language switch.
  const defaultWorkspaceName = t('workspace.defaultName')
  const listed = useMemo(() => {
    if (!pinAdd) return []
    const rows = workspaces.map(workspace => ({
      id: workspace.workspaceId,
      title: workspaceDisplayTitle(workspace.title, defaultWorkspaceName),
      path: workspace.path,
    }))
    const suffixes = distinguishingPathSuffixes(rows)
    return rows.map(row => ({ ...row, suffix: suffixes.get(row.id) }))
  }, [pinAdd, workspaces, defaultWorkspaceName])
  const items: MenuEntry[] = pinAdd
    ? listed.map(({ id, title, path, suffix }) => ({
      id,
      // The title gives way first, so the suffix that tells the rows apart
      // stays visible; the native tooltip carries the full path.
      label: suffix === undefined
        ? title
        : (
          <span className={css.disambiguated} title={path}>
            <span className={css.title}>{title}</span>
            {' '}
            <span className={css.pathSuffix}>{suffix}</span>
          </span>
        ),
      icon: <IconFolderCloseRegular size={16} />,
      disabled: flowBusy,
    }))
    : addEntries
  // Nothing listed and nothing to add with (a composition that mounts this
  // package without any directory-picker): an empty popover would claim a
  // choice that does not exist, so the anchor gesture shows nothing at all.
  const menuIsEmpty = items.length === 0

  const openDirectoryFlow = useCallback((): void => {
    onClose()
    setCreating(true)
  }, [onClose])

  // A menu exists to disambiguate between targets. With no workspaces listed
  // and the add action the only entry left, the anchor gesture IS that action:
  // a one-row popover would cost a click and offer nothing to choose between.
  // The owner's open request is consumed the same way selecting the entry
  // would consume it (close the popover, raise the flow). An empty list is
  // only final once the baseline lands — until then the menu stays up with its
  // loading status instead of jumping into a flow the arriving list would have
  // made unnecessary; the add-only surface lists nothing and never waits.
  const listSettled = addOnly || workspaceSnapshot.phase === 'ready'
  const addIsTheOnlyEntry = !pinAdd && listSettled && addEntries.length === 1
  // `flowBusy` gates this exactly as it disables the equivalent menu entry: a
  // pick still being adopted owns the surface until it settles.
  useEffect(() => {
    if (open && addIsTheOnlyEntry && !flowBusy) openDirectoryFlow()
  }, [open, addIsTheOnlyEntry, flowBusy, openDirectoryFlow])

  const handleSelect = (id: string): void => {
    if (id === ADD_WORKSPACE) {
      openDirectoryFlow()
      return
    }
    onPick(id as WorkspaceId)
  }

  return (
    <>
      <Menu
        open={open && !addIsTheOnlyEntry && !menuIsEmpty}
        anchor={null}
        items={items}
        {...pinAdd ? { footer: addEntries } : {}}
        selectedId={selectedId}
        onSelect={handleSelect}
        onClose={onClose}
        side={side}
        portal
        anchorRef={anchorRef ?? absentAnchor}
      />
      {open && !addIsTheOnlyEntry && !menuIsEmpty && workspaceSnapshot.phase === 'pending' && <div className={css.menuStatus} role="status">{t('picker.loading')}</div>}
      {creating && <WorkspaceCreateDialog t={t} createWorkspace={createWorkspace} renderDirectoryFlow={renderDirectoryFlow}
        pickerAvailable={flowAvailable} onClose={() => { setCreating(false) }}
        onPick={id => { setCreating(false); onPick(id) }} />}

    </>
  )
}

/**
 * The conversation empty-state registration: adapts the owner share to the
 * core flow (all state and semantics live in the flow / the owner).
 * @param props - empty-state slot props (owner share + injected creation callback).
 * @returns the flow element.
 */
export function WorkspacePicker({
  open,
  anchorRef,
  useWorkspaces,
  selectedId,
  onPick,
  onClose,
  createWorkspace,
  useDirectoryFlow,
  renderSlot,
  t,
}: WorkspacePickerProps) {
  return (
    <WorkspacePickFlow
      t={t}
      open={open}
      anchorRef={anchorRef}
      useWorkspaces={useWorkspaces}
      createWorkspace={createWorkspace}
      useDirectoryFlow={useDirectoryFlow}
      renderDirectoryFlow={owner => renderSlot('conversation.hero.workspace.directoryFlow', owner)}
      selectedId={selectedId}
      onPick={onPick}
      onClose={onClose}
    />
  )
}
