import { makeAutoObservable, runInAction } from "mobx"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const { loadTexture } = vi.hoisted(() => ({
  loadTexture: vi.fn<(path: string) => Promise<unknown>>(),
}))

vi.mock("pixi.js", () => ({
  Assets: {
    load: loadTexture,
  },
  Texture: {
    from: () => ({
      destroy: vi.fn(),
    }),
  },
}))

import { createTextureActions, isFallbackTexture } from "@/renderer/texture/texture-manager"

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({}) })))
})

afterEach(() => {
  loadTexture.mockReset()
  vi.unstubAllGlobals()
})

class ScreenProfileState {
  public devicePixelRatio = 2

  public constructor() {
    makeAutoObservable(this, {}, { autoBind: true })
  }
}

describe("TextureActions", () => {
  it("变体单帧图和静态遮罩共用基础版路径", async () => {
    const bitmapTexture = createLoadedTextureMock("shared-body")
    loadTexture.mockResolvedValue(bitmapTexture)
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ variant: "base" }) })))
    const manager = createTextureActions({ renderer: {} as never, app: null })

    await manager.getTexture("device-sprite-variant")
    await manager.getTexture("device-masks-variant")

    expect(loadTexture).toHaveBeenNthCalledWith(1, "/3d-top-view/sprites/base.webp")
    expect(loadTexture).toHaveBeenNthCalledWith(2, "/3d-top-view/sprite-masks/base.webp")
    expect(fetch).toHaveBeenCalledTimes(1)
    manager.destroy()
  })

  it("loads and caches textures by unified resource key", async () => {
    const bodyKey = "device-sprite-item_port_storager_1"
    const bitmapTexture = createLoadedTextureMock("device-body")

    loadTexture.mockResolvedValue(bitmapTexture)

    const manager = createTextureActions({
      renderer: {} as never,
      app: null,
    })

    const firstTexture = await manager.getTexture(bodyKey)
    const secondTexture = await manager.getTexture(bodyKey)

    expect(firstTexture).toBe(bitmapTexture)
    expect(isFallbackTexture(firstTexture)).toBe(false)
    expect(secondTexture).toBe(bitmapTexture)
    expect(loadTexture).toHaveBeenCalledTimes(1)
    expect(loadTexture).toHaveBeenCalledWith("/3d-top-view/sprites/item_port_storager_1.webp")

    manager.destroy()
  })

  it("returns a red fallback texture when the asset fails to load", async () => {
    loadTexture.mockRejectedValue(new Error("not found"))

    const manager = createTextureActions({
      renderer: {} as never,
      app: null,
    })

    const texture = await manager.getTexture("device-sprite-missing")
    expect(texture).toBeDefined()
    expect(isFallbackTexture(texture)).toBe(true)

    manager.destroy()
  })

  it("retries a failed texture once for all active viewers and replaces the cached fallback", async () => {
    vi.useFakeTimers()
    try {
      const recoveredTexture = createLoadedTextureMock("recovered-avatar")
      loadTexture.mockRejectedValueOnce(new Error("temporary outage"))
        .mockResolvedValueOnce(recoveredTexture)
      const manager = createTextureActions({ renderer: {} as never, app: null })
      const key = "top-view-avatar-item_port_udpipe_unloader_1"
      const first = await manager.getTexture(key)
      expect(isFallbackTexture(first)).toBe(true)

      const firstViewer = vi.fn()
      const secondViewer = vi.fn()
      const stopFirst = manager.watchTextureRecovery(key, firstViewer)
      const stopSecond = manager.watchTextureRecovery(key, secondViewer)
      await Promise.resolve()
      await vi.advanceTimersByTimeAsync(1000)

      expect(firstViewer).toHaveBeenCalledExactlyOnceWith(recoveredTexture)
      expect(secondViewer).toHaveBeenCalledExactlyOnceWith(recoveredTexture)
      expect(await manager.getTexture(key)).toBe(recoveredTexture)
      expect(loadTexture).toHaveBeenCalledTimes(2)
      stopFirst()
      stopSecond()
      manager.destroy()
    } finally {
      vi.useRealTimers()
    }
  })

  it("stops texture retries after the last viewer leaves", async () => {
    vi.useFakeTimers()
    try {
      loadTexture.mockRejectedValue(new Error("offline"))
      const manager = createTextureActions({ renderer: {} as never, app: null })
      const key = "blueprint-sprite-item_port_sp_sub_hub_1"
      const viewer = vi.fn()
      const stop = manager.watchTextureRecovery(key, viewer)
      await Promise.resolve()
      await Promise.resolve()
      stop()
      await vi.advanceTimersByTimeAsync(3000)

      expect(loadTexture).toHaveBeenCalledTimes(1)
      expect(viewer).not.toHaveBeenCalled()
      manager.destroy()
    } finally {
      vi.useRealTimers()
    }
  })

  it("reloads body aliases after a temporary request failure", async () => {
    vi.useFakeTimers()
    try {
      vi.stubGlobal("fetch", vi.fn()
        .mockRejectedValueOnce(new Error("alias request failed"))
        .mockResolvedValueOnce({ ok: true, json: async () => ({}) }))
      const recoveredTexture = createLoadedTextureMock("recovered-3d-body")
      loadTexture.mockResolvedValue(recoveredTexture)
      const manager = createTextureActions({ renderer: {} as never, app: null })
      const key = "device-sprite-item_port_sp_sub_hub_1"
      const fallback = await manager.getTexture(key)
      expect(isFallbackTexture(fallback)).toBe(true)

      const recovered = vi.fn()
      manager.watchTextureRecovery(key, recovered)
      await vi.advanceTimersByTimeAsync(1000)

      expect(recovered).toHaveBeenCalledExactlyOnceWith(recoveredTexture)
      expect(fetch).toHaveBeenCalledTimes(2)
      expect(loadTexture).toHaveBeenCalledWith("/3d-top-view/sprites/item_port_sp_sub_hub_1.webp")
      manager.destroy()
    } finally {
      vi.useRealTimers()
    }
  })

  it("returns a red fallback texture for unknown key prefixes", async () => {
    const manager = createTextureActions({
      renderer: {} as never,
      app: null,
    })

    const texture = await manager.getTexture("future-custom-texture")

    expect(texture).toBeDefined()
    expect(loadTexture).not.toHaveBeenCalled()

    manager.destroy()
  })

  it("returns the fallback texture without requesting PNG when a device mask WebP fails", async () => {
    const maskKey = "device-masks-item_port_storager_1"

    loadTexture.mockRejectedValue(new Error("missing webp"))

    const manager = createTextureActions({
      renderer: {} as never,
      app: null,
    })

    const texture = await manager.getTexture(maskKey)
    expect(texture).toBeDefined()
    expect(loadTexture).toHaveBeenCalledTimes(1)
    expect(loadTexture).toHaveBeenCalledWith("/3d-top-view/sprite-masks/item_port_storager_1.webp")

    manager.destroy()
  })

  it("maps every published raster resource family to a single WebP candidate", async () => {
    const texture = createLoadedTextureMock("webp-only")
    loadTexture.mockResolvedValue(texture)

    const manager = createTextureActions({
      renderer: {} as never,
      app: null,
    })

    const cases = [
      ["blueprint-sprite-item_port_storager_1", "/blueprint-view/sprites/item_port_storager_1.webp"],
      ["blueprint-masks-item_port_storager_1", "/blueprint-view/sprite-masks/item_port_storager_1.webp"],
      ["texture-scanline-45deg-50opacity", "/textures/scanline-45deg-50opacity.webp"],
      ["device-masks-item_port_storager_1", "/3d-top-view/sprite-masks/item_port_storager_1.webp"],
      ["item-icon-item_iron_ore", "/item-icons/item_iron_ore.webp"],
    ] as const

    for (const [key, expectedPath] of cases) {
      await manager.getTexture(key)
      expect(loadTexture).toHaveBeenLastCalledWith(expectedPath)
    }

    expect(loadTexture).toHaveBeenCalledTimes(cases.length)
    manager.destroy()
  })

  it("prefix blueprint-masks- maps to blueprint-view sprite-masks assets", async () => {
    const maskKey = "blueprint-masks-item_port_storager_1"
    const maskTexture = createLoadedTextureMock("blueprint-mask")

    loadTexture.mockResolvedValue(maskTexture)

    const manager = createTextureActions({
      renderer: {} as never,
      app: null,
    })

    const texture = await manager.getTexture(maskKey)

    expect(texture).toBe(maskTexture)
    expect(loadTexture).toHaveBeenCalledWith("/blueprint-view/sprite-masks/item_port_storager_1.webp")

    manager.destroy()
  })

  it("prefix item-icon- maps to item-icons assets", async () => {
    const iconKey = "item-icon-item_iron_ore"
    const iconTexture = createLoadedTextureMock("item-icon")

    loadTexture.mockResolvedValue(iconTexture)

    const manager = createTextureActions({
      renderer: {} as never,
      app: null,
    })

    const texture = await manager.getTexture(iconKey)

    expect(texture).toBe(iconTexture)
    expect(loadTexture).toHaveBeenCalledWith("/item-icons/item_iron_ore.webp")

    manager.destroy()
  })

  it("reacts to mobx dpr changes and reapplies bitmap sampling to loaded textures", async () => {
    const screenProfile = new ScreenProfileState()
    const bodyKey = "device-sprite-item_port_storager_1"
    const textureConfigs: unknown[] = []
    const bitmapTexture = {
      source: {
        scaleMode: "nearest",
        autoGenerateMipmaps: false,
        mipmapFilter: "nearest",
        style: {
          scaleMode: "nearest",
          mipmapFilter: "nearest",
          maxAnisotropy: 1,
          update: vi.fn(),
        },
        update: vi.fn(),
        updateMipmaps: vi.fn(),
      },
      update: vi.fn(),
    }

    loadTexture.mockResolvedValue(bitmapTexture)

    const manager = createTextureActions({
      renderer: {} as never,
      app: {
        state: {
          screenProfile,
        },
      } as never,
      syncTextureConfigState: (textureConfig) => {
        textureConfigs.push(textureConfig)
      },
    })

    await manager.getTexture(bodyKey)

    expect(textureConfigs.at(-1)).toMatchObject({
      renderResolution: 2,
    })

    runInAction(() => {
      screenProfile.devicePixelRatio = 3
    })

    expect(textureConfigs.at(-1)).toMatchObject({
      renderResolution: 3,
    })
    expect(bitmapTexture.source.scaleMode).toBe("linear")
    expect(bitmapTexture.source.autoGenerateMipmaps).toBe(true)
    expect(bitmapTexture.source.updateMipmaps).toHaveBeenCalledTimes(2)

    manager.destroy()
  })
})

function createLoadedTextureMock(id: string) {
  return {
    id,
    source: {
      scaleMode: "linear",
      autoGenerateMipmaps: false,
      mipmapFilter: "nearest",
      style: {
        scaleMode: "nearest",
        mipmapFilter: "nearest",
        maxAnisotropy: 4,
        update: vi.fn(),
      },
      update: vi.fn(),
      updateMipmaps: vi.fn(),
    },
    update: vi.fn(),
  }
}
