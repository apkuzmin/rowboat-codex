import { useState, useEffect, useCallback } from "react"
import { setGoogleCredentials } from "@/lib/google-credentials-store"
import { toast } from "sonner"
import { useCodexAuthState } from "@/hooks/useCodexAuthState"

export interface ProviderState {
  isConnected: boolean
  isLoading: boolean
  isConnecting: boolean
}

export type Step = 0 | 1 | 2 | 3

export type OnboardingPath = 'rowboat' | 'chatgpt-codex' | 'byok' | null
export type LlmProviderMode = 'byok' | 'chatgpt-codex'
type AccountProviderMode = Exclude<LlmProviderMode, 'byok'>

export type LlmProviderFlavor = "openai" | "anthropic" | "google" | "openrouter" | "aigateway" | "ollama" | "openai-compatible"

export interface LlmModelOption {
  id: string
  name?: string
  release_date?: string
}

interface ProviderCatalogMeta {
  catalogSource?: 'discovered' | 'fallback'
  invalidSavedModels?: string[]
  defaultModel?: string
  defaultKnowledgeGraphModel?: string
  defaultMeetingNotesModel?: string
}

type AccountProviderSavePayload = {
  providerMode: AccountProviderMode
  model: string
  models: string[]
  knowledgeGraphModel?: string
  meetingNotesModel?: string
}

function normalizeModelList(models: string[], primaryModel?: string): string[] {
  const normalized = models.map((model) => model.trim()).filter(Boolean)
  const ordered = primaryModel?.trim()
    ? [primaryModel.trim(), ...normalized.filter((model) => model !== primaryModel.trim())]
    : normalized
  return [...new Set(ordered)]
}

function buildAccountProviderSavePayload(
  providerMode: AccountProviderMode,
  config: { model: string; knowledgeGraphModel: string },
  previousConfig?: { model?: string; models?: string[]; meetingNotesModel?: string },
): AccountProviderSavePayload {
  const models = normalizeModelList(
    Array.isArray(previousConfig?.models) ? previousConfig.models : [config.model],
    config.model || previousConfig?.model,
  )
  return {
    providerMode,
    model: models[0] || config.model.trim(),
    models,
    knowledgeGraphModel: config.knowledgeGraphModel.trim() || undefined,
    meetingNotesModel: previousConfig?.meetingNotesModel?.trim() || undefined,
  }
}

export function useOnboardingState(open: boolean, onComplete: () => void) {
  const codexAuth = useCodexAuthState(open)
  const [currentStep, setCurrentStep] = useState<Step>(0)
  const [onboardingPath, setOnboardingPath] = useState<OnboardingPath>(null)

  // LLM setup state
  const [llmProviderMode, setLlmProviderMode] = useState<LlmProviderMode>("byok")
  const [llmProvider, setLlmProvider] = useState<LlmProviderFlavor>("openai")
  const [modelsCatalog, setModelsCatalog] = useState<Record<string, LlmModelOption[]>>({})
  const [catalogMeta, setCatalogMeta] = useState<Record<string, ProviderCatalogMeta>>({})
  const [modelsLoading, setModelsLoading] = useState(false)
  const [modelsError, setModelsError] = useState<string | null>(null)
  const [providerConfigs, setProviderConfigs] = useState<Record<LlmProviderFlavor, { apiKey: string; baseURL: string; model: string; knowledgeGraphModel: string }>>({
    openai: { apiKey: "", baseURL: "", model: "", knowledgeGraphModel: "" },
    anthropic: { apiKey: "", baseURL: "", model: "", knowledgeGraphModel: "" },
    google: { apiKey: "", baseURL: "", model: "", knowledgeGraphModel: "" },
    openrouter: { apiKey: "", baseURL: "", model: "", knowledgeGraphModel: "" },
    aigateway: { apiKey: "", baseURL: "", model: "", knowledgeGraphModel: "" },
    ollama: { apiKey: "", baseURL: "http://localhost:11434", model: "", knowledgeGraphModel: "" },
    "openai-compatible": { apiKey: "", baseURL: "http://localhost:1234/v1", model: "", knowledgeGraphModel: "" },
  })
  const [accountProviderConfigs, setAccountProviderConfigs] = useState<Record<AccountProviderMode, { model: string; knowledgeGraphModel: string }>>({
    'chatgpt-codex': { model: "", knowledgeGraphModel: "" },
  })
  const [testState, setTestState] = useState<{ status: "idle" | "testing" | "success" | "error"; error?: string }>({
    status: "idle",
  })
  const [showMoreProviders, setShowMoreProviders] = useState(false)

  // OAuth provider states
  const [providers, setProviders] = useState<string[]>([])
  const [providersLoading, setProvidersLoading] = useState(true)
  const [providerStates, setProviderStates] = useState<Record<string, ProviderState>>({})
  const [providerStatus, setProviderStatus] = useState<Record<string, { email?: string | null; planType?: string | null; error?: string | null }>>({})
  const [googleClientIdOpen, setGoogleClientIdOpen] = useState(false)

  // Granola state
  const [granolaEnabled, setGranolaEnabled] = useState(false)
  const [granolaLoading, setGranolaLoading] = useState(true)

  // Slack state (agent-slack CLI)
  const [slackEnabled, setSlackEnabled] = useState(false)
  const [slackLoading, setSlackLoading] = useState(true)
  const [slackWorkspaces, setSlackWorkspaces] = useState<Array<{ url: string; name: string }>>([])
  const [slackAvailableWorkspaces, setSlackAvailableWorkspaces] = useState<Array<{ url: string; name: string }>>([])
  const [slackSelectedUrls, setSlackSelectedUrls] = useState<Set<string>>(new Set())
  const [slackPickerOpen, setSlackPickerOpen] = useState(false)
  const [slackDiscovering, setSlackDiscovering] = useState(false)
  const [slackDiscoverError, setSlackDiscoverError] = useState<string | null>(null)

  // Inline upsell callout dismissed
  const [upsellDismissed, setUpsellDismissed] = useState(false)

  // Composio/Gmail state (used when signed in with Rowboat account)
  const [useComposioForGoogle, setUseComposioForGoogle] = useState(false)
  const [gmailConnected, setGmailConnected] = useState(false)
  const [gmailLoading, setGmailLoading] = useState(true)
  const [gmailConnecting, setGmailConnecting] = useState(false)
  const [composioApiKeyOpen, setComposioApiKeyOpen] = useState(false)
  const [composioApiKeyTarget, setComposioApiKeyTarget] = useState<'slack' | 'gmail'>('gmail')

  // Composio/Google Calendar state
  const [useComposioForGoogleCalendar, setUseComposioForGoogleCalendar] = useState(false)
  const [googleCalendarConnected, setGoogleCalendarConnected] = useState(false)
  const [googleCalendarLoading, setGoogleCalendarLoading] = useState(true)
  const [googleCalendarConnecting, setGoogleCalendarConnecting] = useState(false)

  const updateProviderConfig = useCallback(
    (provider: LlmProviderFlavor, updates: Partial<{ apiKey: string; baseURL: string; model: string; knowledgeGraphModel: string }>) => {
      setProviderConfigs(prev => ({
        ...prev,
        [provider]: { ...prev[provider], ...updates },
      }))
      setTestState({ status: "idle" })
    },
    []
  )

  const updateAccountProviderConfig = useCallback(
    (provider: AccountProviderMode, updates: Partial<{ model: string; knowledgeGraphModel: string }>) => {
      setAccountProviderConfigs(prev => ({
        ...prev,
        [provider]: { ...prev[provider], ...updates },
      }))
      setTestState({ status: "idle" })
    },
    []
  )

  const activeConfig = llmProviderMode === "byok"
    ? providerConfigs[llmProvider]
    : accountProviderConfigs[llmProviderMode]
  const activeApiKey =
    "apiKey" in activeConfig && typeof activeConfig.apiKey === "string"
      ? activeConfig.apiKey
      : ""
  const activeBaseURL =
    "baseURL" in activeConfig && typeof activeConfig.baseURL === "string"
      ? activeConfig.baseURL
      : ""
  const showApiKey = llmProviderMode === "byok" && (llmProvider === "openai" || llmProvider === "anthropic" || llmProvider === "google" || llmProvider === "openrouter" || llmProvider === "aigateway" || llmProvider === "openai-compatible")
  const requiresApiKey = llmProviderMode === "byok" && (llmProvider === "openai" || llmProvider === "anthropic" || llmProvider === "google" || llmProvider === "openrouter" || llmProvider === "aigateway")
  const requiresBaseURL = llmProviderMode === "byok" && (llmProvider === "ollama" || llmProvider === "openai-compatible")
  const showBaseURL = llmProviderMode === "byok" && (llmProvider === "ollama" || llmProvider === "openai-compatible" || llmProvider === "aigateway")
  const isLocalProvider = llmProviderMode === "byok" && (llmProvider === "ollama" || llmProvider === "openai-compatible")
  const canTest =
    activeConfig.model.trim().length > 0 &&
    (!requiresApiKey || activeApiKey.trim().length > 0) &&
    (!requiresBaseURL || activeBaseURL.trim().length > 0)
  const canSaveAccountProvider =
    llmProviderMode !== "byok" &&
    activeConfig.model.trim().length > 0 &&
    codexAuth.state.isConnected

  // Track connected providers for the completion step
  const connectedProviders = Object.entries(providerStates)
    .filter(([, state]) => state.isConnected)
    .map(([provider]) => provider)

  // Load available providers and composio-for-google flag on mount
  useEffect(() => {
    if (!open) return

    async function loadProviders() {
      try {
        setProvidersLoading(true)
        const result = await window.ipc.invoke('oauth:list-providers', null)
        const nextProviders = Array.isArray(result.providers) ? result.providers : []
        setProviders(nextProviders.filter((provider: string) => provider !== 'chatgpt-codex'))
      } catch (error) {
        console.error('Failed to get available providers:', error)
        setProviders([])
      } finally {
        setProvidersLoading(false)
      }
    }
    async function loadComposioForGoogleFlag() {
      try {
        const result = await window.ipc.invoke('composio:use-composio-for-google', null)
        setUseComposioForGoogle(result.enabled)
      } catch (error) {
        console.error('Failed to check composio-for-google flag:', error)
      }
    }
    async function loadComposioForGoogleCalendarFlag() {
      try {
        const result = await window.ipc.invoke('composio:use-composio-for-google-calendar', null)
        setUseComposioForGoogleCalendar(result.enabled)
      } catch (error) {
        console.error('Failed to check composio-for-google-calendar flag:', error)
      }
    }
    loadProviders()
    loadComposioForGoogleFlag()
    loadComposioForGoogleCalendarFlag()
  }, [open])

  // Load LLM models catalog on open
  useEffect(() => {
    if (!open) return

    async function loadModels() {
      try {
        setModelsLoading(true)
        setModelsError(null)
        const result = await window.ipc.invoke("models:list", { mode: llmProviderMode })
        const catalog: Record<string, LlmModelOption[]> = {}
        const nextCatalogMeta: Record<string, ProviderCatalogMeta> = {}
        for (const provider of result.providers || []) {
          catalog[provider.id] = provider.models || []
          nextCatalogMeta[provider.id] = provider.meta || {}
        }
        setModelsCatalog(catalog)
        setCatalogMeta(nextCatalogMeta)
      } catch (error) {
        console.error("Failed to load models catalog:", error)
        setModelsError("Failed to load models list")
        setModelsCatalog({})
        setCatalogMeta({})
      } finally {
        setModelsLoading(false)
      }
    }

    loadModels()
  }, [open, llmProviderMode])

  // Preferred default models for each provider
  const preferredDefaults: Partial<Record<LlmProviderFlavor, string>> = {
    openai: "gpt-5.2",
    anthropic: "claude-opus-4-6-20260202",
  }

  // Initialize default models from catalog
  useEffect(() => {
    if (Object.keys(modelsCatalog).length === 0) return
    setProviderConfigs(prev => {
      const next = { ...prev }
      const cloudProviders: LlmProviderFlavor[] = ["openai", "anthropic", "google"]
      for (const provider of cloudProviders) {
        const models = modelsCatalog[provider]
        if (models?.length && !next[provider].model) {
          const preferredModel = preferredDefaults[provider]
          const hasPreferred = preferredModel && models.some(m => m.id === preferredModel)
          next[provider] = { ...next[provider], model: hasPreferred ? preferredModel : (models[0]?.id || "") }
        }
      }
      return next
    })
  }, [modelsCatalog])

  useEffect(() => {
    if (llmProviderMode === "byok") return
    const models = modelsCatalog[llmProviderMode]
    if (!models?.length) return
    const meta = catalogMeta[llmProviderMode] || {}
    const validIds = new Set(models.map((model) => model.id))
    const defaultModel = meta.defaultModel || models[0]?.id || ""
    const defaultKnowledgeGraphModel = meta.defaultKnowledgeGraphModel
      || models.find((model) => model.id.toLowerCase().includes('mini'))?.id
      || defaultModel
    setAccountProviderConfigs(prev => {
      const current = prev[llmProviderMode]
      const nextModel = current.model && validIds.has(current.model) ? current.model : defaultModel
      const nextKnowledgeGraphModel = current.knowledgeGraphModel && validIds.has(current.knowledgeGraphModel)
        ? current.knowledgeGraphModel
        : defaultKnowledgeGraphModel
      if (nextModel === current.model && nextKnowledgeGraphModel === current.knowledgeGraphModel) return prev
      return {
        ...prev,
        [llmProviderMode]: { ...current, model: nextModel, knowledgeGraphModel: nextKnowledgeGraphModel },
      }
    })
  }, [catalogMeta, llmProviderMode, modelsCatalog])

  // Load Granola config
  const refreshGranolaConfig = useCallback(async () => {
    try {
      setGranolaLoading(true)
      const result = await window.ipc.invoke('granola:getConfig', null)
      setGranolaEnabled(result.enabled)
    } catch (error) {
      console.error('Failed to load Granola config:', error)
      setGranolaEnabled(false)
    } finally {
      setGranolaLoading(false)
    }
  }, [])

  // Update Granola config
  const handleGranolaToggle = useCallback(async (enabled: boolean) => {
    try {
      setGranolaLoading(true)
      await window.ipc.invoke('granola:setConfig', { enabled })
      setGranolaEnabled(enabled)
      toast.success(enabled ? 'Granola sync enabled' : 'Granola sync disabled')
    } catch (error) {
      console.error('Failed to update Granola config:', error)
      toast.error('Failed to update Granola sync settings')
    } finally {
      setGranolaLoading(false)
    }
  }, [])

  // Load Slack config
  const refreshSlackConfig = useCallback(async () => {
    try {
      setSlackLoading(true)
      const result = await window.ipc.invoke('slack:getConfig', null)
      setSlackEnabled(result.enabled)
      setSlackWorkspaces(result.workspaces || [])
    } catch (error) {
      console.error('Failed to load Slack config:', error)
      setSlackEnabled(false)
      setSlackWorkspaces([])
    } finally {
      setSlackLoading(false)
    }
  }, [])

  // Enable Slack: discover workspaces
  const handleSlackEnable = useCallback(async () => {
    setSlackDiscovering(true)
    setSlackDiscoverError(null)
    try {
      const result = await window.ipc.invoke('slack:listWorkspaces', null)
      if (result.error || result.workspaces.length === 0) {
        setSlackDiscoverError(result.error || 'No Slack workspaces found. Set up with: agent-slack auth import-desktop')
        setSlackAvailableWorkspaces([])
        setSlackPickerOpen(true)
      } else {
        setSlackAvailableWorkspaces(result.workspaces)
        setSlackSelectedUrls(new Set(result.workspaces.map((w: { url: string }) => w.url)))
        setSlackPickerOpen(true)
      }
    } catch (error) {
      console.error('Failed to discover Slack workspaces:', error)
      setSlackDiscoverError('Failed to discover Slack workspaces')
      setSlackPickerOpen(true)
    } finally {
      setSlackDiscovering(false)
    }
  }, [])

  // Save selected Slack workspaces
  const handleSlackSaveWorkspaces = useCallback(async () => {
    const selected = slackAvailableWorkspaces.filter(w => slackSelectedUrls.has(w.url))
    try {
      setSlackLoading(true)
      await window.ipc.invoke('slack:setConfig', { enabled: true, workspaces: selected })
      setSlackEnabled(true)
      setSlackWorkspaces(selected)
      setSlackPickerOpen(false)
      toast.success('Slack enabled')
    } catch (error) {
      console.error('Failed to save Slack config:', error)
      toast.error('Failed to save Slack settings')
    } finally {
      setSlackLoading(false)
    }
  }, [slackAvailableWorkspaces, slackSelectedUrls])

  // Disable Slack
  const handleSlackDisable = useCallback(async () => {
    try {
      setSlackLoading(true)
      await window.ipc.invoke('slack:setConfig', { enabled: false, workspaces: [] })
      setSlackEnabled(false)
      setSlackWorkspaces([])
      setSlackPickerOpen(false)
      toast.success('Slack disabled')
    } catch (error) {
      console.error('Failed to update Slack config:', error)
      toast.error('Failed to update Slack settings')
    } finally {
      setSlackLoading(false)
    }
  }, [])

  // Load Gmail connection status (Composio)
  const refreshGmailStatus = useCallback(async () => {
    try {
      setGmailLoading(true)
      const result = await window.ipc.invoke('composio:get-connection-status', { toolkitSlug: 'gmail' })
      setGmailConnected(result.isConnected)
    } catch (error) {
      console.error('Failed to load Gmail status:', error)
      setGmailConnected(false)
    } finally {
      setGmailLoading(false)
    }
  }, [])

  // Connect to Gmail via Composio
  const startGmailConnect = useCallback(async () => {
    try {
      setGmailConnecting(true)
      const result = await window.ipc.invoke('composio:initiate-connection', { toolkitSlug: 'gmail' })
      if (!result.success) {
        toast.error(result.error || 'Failed to connect to Gmail')
        setGmailConnecting(false)
      }
    } catch (error) {
      console.error('Failed to connect to Gmail:', error)
      toast.error('Failed to connect to Gmail')
      setGmailConnecting(false)
    }
  }, [])

  // Handle Gmail connect button click (checks Composio config first)
  const handleConnectGmail = useCallback(async () => {
    const configResult = await window.ipc.invoke('composio:is-configured', null)
    if (!configResult.configured) {
      setComposioApiKeyTarget('gmail')
      setComposioApiKeyOpen(true)
      return
    }
    await startGmailConnect()
  }, [startGmailConnect])

  // Handle Composio API key submission
  const handleComposioApiKeySubmit = useCallback(async (apiKey: string) => {
    try {
      await window.ipc.invoke('composio:set-api-key', { apiKey })
      setComposioApiKeyOpen(false)
      toast.success('Composio API key saved')
      await startGmailConnect()
    } catch (error) {
      console.error('Failed to save Composio API key:', error)
      toast.error('Failed to save API key')
    }
  }, [startGmailConnect])

  // Load Google Calendar connection status (Composio)
  const refreshGoogleCalendarStatus = useCallback(async () => {
    try {
      setGoogleCalendarLoading(true)
      const result = await window.ipc.invoke('composio:get-connection-status', { toolkitSlug: 'googlecalendar' })
      setGoogleCalendarConnected(result.isConnected)
    } catch (error) {
      console.error('Failed to load Google Calendar status:', error)
      setGoogleCalendarConnected(false)
    } finally {
      setGoogleCalendarLoading(false)
    }
  }, [])

  // Connect to Google Calendar via Composio
  const startGoogleCalendarConnect = useCallback(async () => {
    try {
      setGoogleCalendarConnecting(true)
      const result = await window.ipc.invoke('composio:initiate-connection', { toolkitSlug: 'googlecalendar' })
      if (!result.success) {
        toast.error(result.error || 'Failed to connect to Google Calendar')
        setGoogleCalendarConnecting(false)
      }
    } catch (error) {
      console.error('Failed to connect to Google Calendar:', error)
      toast.error('Failed to connect to Google Calendar')
      setGoogleCalendarConnecting(false)
    }
  }, [])

  // Handle Google Calendar connect button click
  const handleConnectGoogleCalendar = useCallback(async () => {
    const configResult = await window.ipc.invoke('composio:is-configured', null)
    if (!configResult.configured) {
      setComposioApiKeyTarget('gmail')
      setComposioApiKeyOpen(true)
      return
    }
    await startGoogleCalendarConnect()
  }, [startGoogleCalendarConnect])

  // New step flow:
  // Account-backed path: 0 (welcome) → 2 (connect) → 3 (done)
  // BYOK path: 0 (welcome) → 1 (llm setup) → 2 (connect) → 3 (done)
  const handleNext = useCallback(() => {
    if (currentStep === 0) {
      if (onboardingPath === 'rowboat') {
        setCurrentStep(2)
      } else {
        setCurrentStep(1)
      }
    } else if (currentStep === 1) {
      setCurrentStep(2)
    } else if (currentStep === 2) {
      setCurrentStep(3)
    }
  }, [currentStep, onboardingPath])

  const handleBack = useCallback(() => {
    if (currentStep === 1) {
      setCurrentStep(0)
      setOnboardingPath(null)
    } else if (currentStep === 2) {
      if (onboardingPath === 'rowboat') {
        setCurrentStep(0)
      } else {
        setCurrentStep(1)
      }
    }
  }, [currentStep, onboardingPath])

  const handleComplete = useCallback(() => {
    onComplete()
  }, [onComplete])

  const handleTestAndSaveLlmConfig = useCallback(async () => {
    if (llmProviderMode === 'byok' && !canTest) return
    if (llmProviderMode !== 'byok' && !canSaveAccountProvider) return
    setTestState({ status: "testing" })
    try {
      const model = activeConfig.model.trim()
      const knowledgeGraphModel = activeConfig.knowledgeGraphModel.trim() || undefined
      if (llmProviderMode === 'byok') {
        const byokConfig = providerConfigs[llmProvider]
        const apiKey = byokConfig.apiKey.trim() || undefined
        const baseURL = byokConfig.baseURL.trim() || undefined
        const providerConfig = {
          providerMode: "byok" as const,
          provider: {
            flavor: llmProvider,
            apiKey,
            baseURL,
          },
          model,
          knowledgeGraphModel,
        }
        const result = await window.ipc.invoke("models:test", providerConfig)
        if (!result.success) {
          setTestState({ status: "error", error: result.error })
          toast.error(result.error || "Connection test failed")
          return
        }
        setTestState({ status: "success" })
        await window.ipc.invoke("models:saveConfig", providerConfig)
        window.dispatchEvent(new Event('models-config-changed'))
        handleNext()
        return
      }
      let previousAccountConfig: { model?: string; models?: string[]; meetingNotesModel?: string } | undefined
      try {
        const result = await window.ipc.invoke("workspace:readFile", { path: "config/models.json" })
        const parsed = JSON.parse(result.data)
        if (parsed?.providerMode === llmProviderMode) {
          previousAccountConfig = {
            model: typeof parsed?.model === "string" ? parsed.model : undefined,
            models: Array.isArray(parsed?.models) ? parsed.models : undefined,
            meetingNotesModel: typeof parsed?.meetingNotesModel === "string" ? parsed.meetingNotesModel : undefined,
          }
        }
      } catch {
        // No existing config yet.
      }
      await window.ipc.invoke("models:saveConfig", buildAccountProviderSavePayload(
        llmProviderMode,
        {
          model,
          knowledgeGraphModel: knowledgeGraphModel || "",
        },
        previousAccountConfig,
      ))
      setTestState({ status: "success" })
      window.dispatchEvent(new Event('models-config-changed'))
      handleNext()
    } catch (error) {
      console.error("Connection test failed:", error)
      setTestState({ status: "error", error: "Connection test failed" })
      toast.error("Connection test failed")
    }
  }, [activeConfig, canSaveAccountProvider, canTest, handleNext, llmProvider, llmProviderMode, providerConfigs])

  // Check connection status for all providers
  const refreshAllStatuses = useCallback(async () => {
    refreshGranolaConfig()
    refreshSlackConfig()

    // Refresh Gmail Composio status if enabled
    if (useComposioForGoogle) {
      refreshGmailStatus()
    }

    // Refresh Google Calendar Composio status if enabled
    if (useComposioForGoogleCalendar) {
      refreshGoogleCalendarStatus()
    }

    if (providers.length === 0) return

    const newStates: Record<string, ProviderState> = {}

    try {
      const result = await window.ipc.invoke('oauth:getState', null)
      const config = result.config || {}
      const nextStatus: Record<string, { email?: string | null; planType?: string | null; error?: string | null }> = {}
      for (const provider of providers) {
        newStates[provider] = {
          isConnected: config[provider]?.connected ?? false,
          isLoading: false,
          isConnecting: false,
        }
        nextStatus[provider] = {
          email: config[provider]?.email ?? null,
          planType: config[provider]?.planType ?? null,
          error: config[provider]?.error ?? null,
        }
      }
      setProviderStatus(nextStatus)
    } catch (error) {
      console.error('Failed to check connection status for providers:', error)
      for (const provider of providers) {
        newStates[provider] = {
          isConnected: false,
          isLoading: false,
          isConnecting: false,
        }
      }
      setProviderStatus({})
    }

    setProviderStates(newStates)
  }, [providers, refreshGranolaConfig, refreshSlackConfig, refreshGmailStatus, useComposioForGoogle, refreshGoogleCalendarStatus, useComposioForGoogleCalendar])

  // Refresh statuses when modal opens or providers list changes
  useEffect(() => {
    if (open && providers.length > 0) {
      refreshAllStatuses()
    }
  }, [open, providers, refreshAllStatuses])

  // Listen for OAuth completion events (state updates only — toasts handled by ConnectorsPopover)
  useEffect(() => {
    const cleanup = window.ipc.on('oauth:didConnect', (event) => {
      const { provider, success } = event
      if (provider === 'chatgpt-codex') return

      setProviderStates(prev => ({
        ...prev,
        [provider]: {
          isConnected: success,
          isLoading: false,
          isConnecting: false,
        }
      }))
      setProviderStatus(prev => ({
        ...prev,
        [provider]: {
          email: event.email ?? prev[provider]?.email ?? null,
          planType: event.planType ?? prev[provider]?.planType ?? null,
          error: event.error ?? null,
        },
      }))
    })

    return cleanup
  }, [])

  // Auto-advance from Rowboat sign-in step when OAuth completes
  useEffect(() => {
    if (onboardingPath !== 'rowboat' || currentStep !== 0) return

    const cleanup = window.ipc.on('oauth:didConnect', async (event) => {
      if (event.provider === onboardingPath && event.success) {
        // Re-check composio flags now that the account is connected
        try {
          const [googleResult, calendarResult] = await Promise.all([
            window.ipc.invoke('composio:use-composio-for-google', null),
            window.ipc.invoke('composio:use-composio-for-google-calendar', null),
          ])
          setUseComposioForGoogle(googleResult.enabled)
          setUseComposioForGoogleCalendar(calendarResult.enabled)
        } catch (error) {
          console.error('Failed to re-check composio flags:', error)
        }
        setCurrentStep(2) // Go to Connect Accounts
      }
    })

    return cleanup
  }, [onboardingPath, currentStep])

  // Listen for Composio connection events (state updates only — toasts handled by ConnectorsPopover)
  useEffect(() => {
    const cleanup = window.ipc.on('composio:didConnect', (event) => {
      const { toolkitSlug, success } = event

      if (toolkitSlug === 'slack') {
        setSlackEnabled(success)
      }

      if (toolkitSlug === 'gmail') {
        setGmailConnected(success)
        setGmailConnecting(false)
      }

      if (toolkitSlug === 'googlecalendar') {
        setGoogleCalendarConnected(success)
        setGoogleCalendarConnecting(false)
      }
    })

    return cleanup
  }, [])

  const startConnect = useCallback(async (
    provider: string,
    credentials?: { clientId: string; clientSecret: string },
    mode: 'browser' | 'device' = 'browser',
  ) => {
    if (provider === 'chatgpt-codex') {
      if (mode === 'device') {
        await codexAuth.startDeviceConnect()
      } else {
        await codexAuth.connect()
      }
      return
    }

    setProviderStates(prev => ({
      ...prev,
      [provider]: { ...prev[provider], isConnecting: true }
    }))

    try {
      const result = await window.ipc.invoke('oauth:connect', {
        provider,
        clientId: credentials?.clientId,
        clientSecret: credentials?.clientSecret,
        mode,
      })

      if (!result.success) {
        toast.error(result.error || `Failed to connect to ${provider}`)
        setProviderStates(prev => ({
          ...prev,
          [provider]: { ...prev[provider], isConnecting: false }
        }))
      } else if (mode === 'device' && result.deviceCode) {
        toast.success('Enter the device code in ChatGPT', {
          description: `${result.deviceCode}${result.verificationUrl ? ` at ${result.verificationUrl}` : ''}`,
          duration: 12000,
        })
      }
    } catch (error) {
      console.error('Failed to connect:', error)
      toast.error(`Failed to connect to ${provider}`)
      setProviderStates(prev => ({
        ...prev,
        [provider]: { ...prev[provider], isConnecting: false }
      }))
    }
  }, [codexAuth])

  // Connect to a provider
  const handleConnect = useCallback(async (provider: string) => {
    if (provider === 'google') {
      setGoogleClientIdOpen(true)
      return
    }

    await startConnect(provider)
  }, [startConnect])

  const startDeviceConnect = useCallback(async (provider: string) => {
    await startConnect(provider, undefined, 'device')
  }, [startConnect])

  const handleGoogleClientIdSubmit = useCallback((clientId: string, clientSecret: string) => {
    setGoogleCredentials(clientId, clientSecret)
    setGoogleClientIdOpen(false)
    startConnect('google', { clientId, clientSecret })
  }, [startConnect])

  // Switch to rowboat path from BYOK inline callout
  const handleSwitchToRowboat = useCallback(() => {
    setOnboardingPath('rowboat')
    setCurrentStep(0)
  }, [])

  return {
    // Step state
    currentStep,
    setCurrentStep,
    onboardingPath,
    setOnboardingPath,

    // LLM state
    llmProviderMode,
    setLlmProviderMode,
    llmProvider,
    setLlmProvider,
    modelsCatalog,
    catalogMeta,
    modelsLoading,
    modelsError,
    providerConfigs,
    accountProviderConfigs,
    activeConfig,
    testState,
    setTestState,
    showApiKey,
    requiresApiKey,
    requiresBaseURL,
    showBaseURL,
    isLocalProvider,
    canTest,
    canSaveAccountProvider,
    showMoreProviders,
    setShowMoreProviders,
    updateProviderConfig,
    updateAccountProviderConfig,
    handleTestAndSaveLlmConfig,

    // OAuth state
    providers,
    providersLoading,
    providerStates,
    providerStatus,
    codexAuth,
    googleClientIdOpen,
    setGoogleClientIdOpen,
    connectedProviders,
    handleConnect,
    handleGoogleClientIdSubmit,
    startConnect,
    startDeviceConnect,

    // Granola state
    granolaEnabled,
    granolaLoading,
    handleGranolaToggle,

    // Slack state
    slackEnabled,
    slackLoading,
    slackWorkspaces,
    slackAvailableWorkspaces,
    slackSelectedUrls,
    setSlackSelectedUrls,
    slackPickerOpen,
    slackDiscovering,
    slackDiscoverError,
    handleSlackEnable,
    handleSlackSaveWorkspaces,
    handleSlackDisable,

    // Upsell
    upsellDismissed,
    setUpsellDismissed,

    // Composio/Gmail state
    useComposioForGoogle,
    gmailConnected,
    gmailLoading,
    gmailConnecting,
    composioApiKeyOpen,
    setComposioApiKeyOpen,
    composioApiKeyTarget,
    handleConnectGmail,
    handleComposioApiKeySubmit,

    // Composio/Google Calendar state
    useComposioForGoogleCalendar,
    googleCalendarConnected,
    googleCalendarLoading,
    googleCalendarConnecting,
    handleConnectGoogleCalendar,

    // Navigation
    handleNext,
    handleBack,
    handleComplete,
    handleSwitchToRowboat,
  }
}

export type OnboardingState = ReturnType<typeof useOnboardingState>
