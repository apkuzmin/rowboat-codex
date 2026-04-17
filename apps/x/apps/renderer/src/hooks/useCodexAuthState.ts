import { useCallback, useEffect, useState } from "react"
import { toast } from "sonner"

const CODEX_PROVIDER = "chatgpt-codex"

export interface CodexAuthProviderState {
  isConnected: boolean
  isLoading: boolean
  isConnecting: boolean
}

export interface CodexAuthStatus {
  error?: string
  email?: string | null
  planType?: string | null
}

export function useCodexAuthState(active: boolean) {
  const [isAvailable, setIsAvailable] = useState(false)
  const [state, setState] = useState<CodexAuthProviderState>({
    isConnected: false,
    isLoading: false,
    isConnecting: false,
  })
  const [status, setStatus] = useState<CodexAuthStatus>({})

  const refreshAvailability = useCallback(async () => {
    try {
      const result = await window.ipc.invoke("oauth:list-providers", null)
      const nextProviders = Array.isArray(result.providers) ? result.providers : []
      setIsAvailable(nextProviders.includes(CODEX_PROVIDER))
    } catch (error) {
      console.error("Failed to get available providers:", error)
      setIsAvailable(false)
    }
  }, [])

  const refresh = useCallback(async () => {
    try {
      setState(prev => ({ ...prev, isLoading: true }))
      const result = await window.ipc.invoke("oauth:getState", null)
      const config = result.config?.[CODEX_PROVIDER]
      setState({
        isConnected: config?.connected ?? false,
        isLoading: false,
        isConnecting: false,
      })
      setStatus({
        error: config?.error ?? undefined,
        email: config?.email ?? null,
        planType: config?.planType ?? null,
      })
    } catch (error) {
      console.error("Failed to check ChatGPT / Codex auth status:", error)
      setState({
        isConnected: false,
        isLoading: false,
        isConnecting: false,
      })
      setStatus({})
    }
  }, [])

  useEffect(() => {
    if (!active) return
    refreshAvailability()
    refresh()
  }, [active, refresh, refreshAvailability])

  useEffect(() => {
    const cleanup = window.ipc.on("oauth:didConnect", (event) => {
      if (event.provider !== CODEX_PROVIDER) return

      setState({
        isConnected: event.success,
        isLoading: false,
        isConnecting: false,
      })
      setStatus({
        email: event.email ?? null,
        planType: event.planType ?? null,
        error: event.error ?? undefined,
      })

      if (event.success) {
        toast.success("Connected to ChatGPT / Codex", {
          description: event.planType
            ? `${event.planType} plan detected${event.email ? ` for ${event.email}` : ""}.`
            : (event.email ? `Connected as ${event.email}.` : "Your ChatGPT account is ready to use."),
          duration: 8000,
        })
      } else if (event.error) {
        toast.error(event.error)
      }
    })

    return cleanup
  }, [])

  const connect = useCallback(async (mode: "browser" | "device" = "browser") => {
    setState(prev => ({ ...prev, isConnecting: true }))

    try {
      const result = await window.ipc.invoke("oauth:connect", {
        provider: CODEX_PROVIDER,
        mode,
      })

      if (!result.success) {
        toast.error(result.error || "Failed to connect to ChatGPT / Codex")
        setState(prev => ({ ...prev, isConnecting: false }))
        return
      }

      if (mode === "device" && result.deviceCode) {
        toast.success("Enter the device code in ChatGPT", {
          description: `${result.deviceCode}${result.verificationUrl ? ` at ${result.verificationUrl}` : ""}`,
          duration: 12000,
        })
      }
    } catch (error) {
      console.error("Failed to connect to ChatGPT / Codex:", error)
      toast.error("Failed to connect to ChatGPT / Codex")
      setState(prev => ({ ...prev, isConnecting: false }))
    }
  }, [])

  const disconnect = useCallback(async () => {
    setState(prev => ({ ...prev, isLoading: true }))

    try {
      const result = await window.ipc.invoke("oauth:disconnect", { provider: CODEX_PROVIDER })
      if (!result.success) {
        toast.error("Failed to disconnect from ChatGPT / Codex")
        setState(prev => ({ ...prev, isLoading: false }))
        return
      }

      toast.success("Disconnected from ChatGPT / Codex")
      setState({
        isConnected: false,
        isLoading: false,
        isConnecting: false,
      })
      setStatus({})
    } catch (error) {
      console.error("Failed to disconnect from ChatGPT / Codex:", error)
      toast.error("Failed to disconnect from ChatGPT / Codex")
      setState(prev => ({ ...prev, isLoading: false }))
    }
  }, [])

  return {
    isAvailable,
    state,
    status,
    refresh,
    connect,
    startDeviceConnect: () => connect("device"),
    disconnect,
  }
}
