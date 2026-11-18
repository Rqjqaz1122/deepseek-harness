// @vitest-environment jsdom
import { contextMenuHook } from '@deepseek-ai/dsh-client-test-runtime'
import type { GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type {
  WorkspaceId, WorkspaceSnapshot, WorkspaceView,
} from '@deepseek-ai/dsh-api-workspace-controller/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { allowAllAccess, bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import type { SessionStatusSnapshot } from '@deepseek-ai/dsh-client-ui-session/client'
import type { DirectoryFlowOwnerProps, WorkspacePickerProps } from '../src/client/contract/slots.ts'
import { WorkspacePicker } from '../src/client/WorkspacePicker.tsx'
import { zh } from '../src/client/locales.ts'

// Every fixture carries the resource hook the resources plugin merges into GlobalStandardProps.
const useResource = (() => ({ status: 'none' as const, value: undefined, failure: undefined, reload: () => {} })) as GlobalStandardProps['useResource']
const usePanelInfo: GlobalStandardProps['usePanelInfo'] = selector => selector({ activePanelId: null })

afterEach(cleanup)

// The seat's key domain is workspace ∪ common; the stub mirrors the real
// lookup chain (namespace, then common vocabulary, then the key).
const t: WorkspacePickerProps['t'] = makeTranslate(zh, commonZh)

const wid = (id: string) => id as WorkspaceId
function workspace(id: string, title = id): WorkspaceView {
  return {
    workspaceId: wid(id), path: `/projects/${id}`, title, sessionIds: [],
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  }
}
function hook<T>(snapshot: T) {
  return function select<S>(selector: (state: T) => S): S { return selector(snapshot) }
}
const sessions: SessionListState = {
  ids: [], byId: {}, phase: 'ready', projectionsBySession: {},
}
const noPendingInteraction: SessionStatusSnapshot = new Map()
const workspaceState = (items: readonly WorkspaceView[]): WorkspaceSnapshot => ({
  items, archivedSessionIds: [], pinnedSessionIds: [], state: 'idle', phase: 'ready', error: null,
})
function anchor(): { current: HTMLElement } {
  const element = document.createElement('button')
  element.getBoundingClientRect = () => ({
    top: 10, left: 20, width: 30, height: 40, right: 50, bottom: 50,
    x: 20, y: 10, toJSON: () => ({}),
  })
  return { current: element }
}

/**
 * Probe occupant of the directory-flow hole: records the latest owner
 * conversation so tests drive onPicked/onCancel/onError like a composed flow
 * package would, and renders a marker element while the flow is open.
 */
function flowProbe() {
  const probe: { owner: DirectoryFlowOwnerProps | undefined } = { owner: undefined }
  const renderSlot = ((_name: string, owner: DirectoryFlowOwnerProps) => {
    probe.owner = owner
    return owner.open ? <div data-testid="directory-flow" data-busy={owner.busy} /> : null
  }) as never
  return { probe, renderSlot }
}

/** Manual occupancy source bound like the renderer would: flip() drives the hook like a real registration change. */
function occupancySource(initial = true) {
  let occupied = initial
  const listeners = new Set<() => void>()
  const useDirectoryFlow = bindSnapshotSelector({
    getSnapshot: () => occupied,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  })
  return {
    useDirectoryFlow,
    flip: (next: boolean) => {
      occupied = next
      for (const listener of [...listeners]) listener()
    },
  }
}

function mount(
  items: readonly WorkspaceView[] = [workspace('alpha', 'Alpha')],
  createWorkspace = vi.fn(),
  occupancy = occupancySource(),
) {
  const onPick = vi.fn()
  const onClose = vi.fn()
  const anchorRef = anchor()
  const { probe, renderSlot } = flowProbe()
  const renderPicker = (nextItems: readonly WorkspaceView[]) => (
    <WorkspacePicker
      open
      anchorRef={anchorRef}
      useSessions={hook(sessions)}
      useSessionStatus={hook(noPendingInteraction)}
      useSessionRetainInfo={() => undefined}
      usePanelInfo={usePanelInfo} useContextMenu={contextMenuHook()} useResource={useResource}
      useWorkspaces={hook(workspaceState(nextItems))}
      {...allowAllAccess}
      onPick={onPick}
      onClose={onClose}
      createWorkspace={createWorkspace}
      useDirectoryFlow={occupancy.useDirectoryFlow}
      renderSlot={renderSlot}
      t={t}
    />
  )
  const view = render(
    renderPicker(items),
  )
  return {
    view, onPick, onClose, createWorkspace, probe, occupancy,
    rerenderItems: (nextItems: readonly WorkspaceView[]) => { view.rerender(renderPicker(nextItems)) },
  }
}

function chooseAdd(): void {
  fireEvent.click(screen.getByRole('menuitem', { name: '添加工作区…' }))
}

describe('WorkspacePicker', () => {
  it('disambiguates same-title workspaces and selects an existing workspace', () => {
    const b = mount([
      { ...workspace('alpha', 'Shared'), path: '/one/a/Shared' },
      { ...workspace('beta', 'Shared'), path: '/two/a/Shared' },
    ])
    fireEvent.click(screen.getByRole('menuitem', { name: 'Shared two/a/Shared' }))
    expect(b.onPick).toHaveBeenCalledWith(wid('beta'))
  })

  it('stages multiple folders and a name before creating once with the chosen primary folder', async () => {
    const created = workspace('adopted')
    const b = mount(undefined, vi.fn(async () => created))
    chooseAdd()
    expect(screen.getByRole('dialog', { name: '创建工作区' })).toBeTruthy()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '创建' }).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '添加文件夹' }))
    act(() => { b.probe.owner!.onPicked('/work/frontend') })
    fireEvent.click(screen.getByRole('button', { name: '添加文件夹' }))
    act(() => { b.probe.owner!.onPicked('/work/backend') })
    expect(b.createWorkspace).not.toHaveBeenCalled()
    fireEvent.change(screen.getByRole('textbox', { name: '工作区名称' }), { target: { value: '产品研发' } })
    fireEvent.click(screen.getByRole('radio', { name: '将 /work/backend 设为主目录' }))
    fireEvent.click(screen.getByRole('button', { name: '创建' }))
    await waitFor(() => { expect(b.onPick).toHaveBeenCalledWith(created.workspaceId) })
    expect(b.createWorkspace).toHaveBeenCalledExactlyOnceWith({ path: '/work/backend', title: '产品研发', additionalPaths: ['/work/frontend'] })
  })

  it('deduplicates picks, removes the primary folder, and selects the remaining folder', async () => {
    const b = mount(undefined, vi.fn(async () => workspace('adopted')))
    chooseAdd()
    for (const folder of ['/work/a', '/work/a', '/work/b']) {
      fireEvent.click(screen.getByRole('button', { name: '添加文件夹' }))
      act(() => { b.probe.owner!.onPicked(folder) })
    }
    expect(screen.getAllByRole('radio')).toHaveLength(2)
    fireEvent.click(screen.getByRole('button', { name: '移除 /work/a' }))
    expect(screen.getByRole<HTMLInputElement>('radio').checked).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '创建' }))
    await waitFor(() => { expect(b.createWorkspace).toHaveBeenCalledWith({ path: '/work/b', title: 'a', additionalPaths: [] }) })
  })

  it('preserves the draft after picker cancellation and closes without registering on Cancel', () => {
    const b = mount()
    chooseAdd()
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '草稿' } })
    fireEvent.click(screen.getByRole('button', { name: '添加文件夹' }))
    act(() => { b.probe.owner!.onCancel() })
    expect(screen.getByRole<HTMLInputElement>('textbox').value).toBe('草稿')
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(b.createWorkspace).not.toHaveBeenCalled()
  })

  it('keeps the draft after a failed create and allows a retry', async () => {
    const create = vi.fn().mockRejectedValueOnce(new Error('permission denied')).mockResolvedValue(workspace('adopted'))
    const b = mount(undefined, create)
    chooseAdd()
    fireEvent.click(screen.getByRole('button', { name: '添加文件夹' }))
    act(() => { b.probe.owner!.onPicked('/work/a') })
    fireEvent.click(screen.getByRole('button', { name: '创建' }))
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toContain('permission denied') })
    expect(screen.getByRole<HTMLInputElement>('textbox').value).toBe('a')
    expect(screen.getByRole('radio')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '创建' }))
    await waitFor(() => { expect(b.onPick).toHaveBeenCalledWith(wid('adopted')) })
  })

  it('blocks duplicate submission and cancellation while the Host saves', async () => {
    let resolve!: (value: WorkspaceView) => void
    const pending = new Promise<WorkspaceView>(done => { resolve = done })
    const b = mount(undefined, vi.fn(() => pending))
    chooseAdd()
    fireEvent.click(screen.getByRole('button', { name: '添加文件夹' }))
    act(() => { b.probe.owner!.onPicked('/work/a') })
    fireEvent.click(screen.getByRole('button', { name: '创建' }))
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '正在创建…' }).disabled).toBe(true)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '取消' }).disabled).toBe(true)
    await act(async () => { resolve(workspace('adopted')); await pending })
    expect(b.createWorkspace).toHaveBeenCalledTimes(1)
  })

  it('ignores a stale picker callback after cancellation and another picker opening', () => {
    const b = mount()
    chooseAdd()
    fireEvent.click(screen.getByRole('button', { name: '添加文件夹' }))
    const stale = b.probe.owner!
    act(() => { stale.onCancel() })
    fireEvent.click(screen.getByRole('button', { name: '添加文件夹' }))
    act(() => { stale.onPicked('/old'); stale.onError('late error') })
    expect(b.probe.owner!.open).toBe(true)
    act(() => { b.probe.owner!.onPicked('/current') })
    expect(screen.queryByText('/old')).toBeNull()
    expect(screen.getByText('/current')).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('shows picker failures in the creation dialog without dropping its draft', () => {
    const b = mount()
    chooseAdd()
    fireEvent.click(screen.getByRole('button', { name: '添加文件夹' }))
    act(() => { b.probe.owner!.onError('chooser unavailable') })
    expect(screen.getByRole('alert').textContent).toBe('chooser unavailable')
    expect(b.createWorkspace).not.toHaveBeenCalled()
  })

  it('opens creation directly when no workspace is listed', () => {
    mount([])
    expect(screen.queryByRole('menu')).toBeNull()
    expect(screen.getByRole('dialog', { name: '创建工作区' })).toBeTruthy()
  })

  it('omits the add action without a composed directory picker', () => {
    mount(undefined, vi.fn(), occupancySource(false))
    expect(screen.queryByRole('menuitem', { name: '添加工作区…' })).toBeNull()
  })

  it('retains a named draft if its directory picker unloads', () => {
    const b = mount()
    chooseAdd()
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '草稿' } })
    fireEvent.click(screen.getByRole('button', { name: '添加文件夹' }))
    act(() => { b.occupancy.flip(false) })
    expect(screen.getByRole<HTMLInputElement>('textbox').value).toBe('草稿')
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '添加文件夹' }).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
  })
})
