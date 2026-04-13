import { Loader2, CheckCircle2 } from "lucide-react"
import { motion } from "motion/react"
import { Button } from "@/components/ui/button"
import type { OnboardingState } from "../use-onboarding-state"
import { OpenAIIcon } from "../provider-icons"

interface WelcomeStepProps {
  state: OnboardingState
}

export function WelcomeStep({ state }: WelcomeStepProps) {
  const rowboatState = state.providerStates['rowboat'] || { isConnected: false, isLoading: false, isConnecting: false }
  const codexState = state.providerStates['chatgpt-codex'] || { isConnected: false, isLoading: false, isConnecting: false }
  const codexAvailable = state.providers.includes('chatgpt-codex')

  return (
    <div className="flex flex-col items-center justify-center text-center flex-1">
      {/* Logo with ambient glow */}
      <motion.div
        initial={{ opacity: 0, scale: 0.8 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
        className="relative mb-8"
      >
        <div className="absolute inset-0 size-16 rounded-2xl bg-primary/10 blur-xl scale-[2.5]" />
        <img src="/logo-only.png" alt="Rowboat" className="relative size-16" />
      </motion.div>

      {/* Tagline badge */}
      <motion.div
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.15 }}
        className="inline-flex items-center gap-2 rounded-full border bg-muted/50 px-3.5 py-1.5 text-xs font-medium text-muted-foreground mb-6"
      >
        <span className="size-1.5 rounded-full bg-green-500 animate-pulse" />
        Your AI coworker, with memory
      </motion.div>

      {/* Main heading */}
      <motion.h1
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.2 }}
        className="text-3xl font-bold tracking-tight mb-3"
      >
        Welcome to Rowboat
      </motion.h1>
      <motion.p
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.3 }}
        className="text-base text-muted-foreground leading-relaxed max-w-sm mb-10"
      >
        Rowboat connects to your work, builds a knowledge graph, and uses that context to help you get things done. Private and on your machine.
      </motion.p>

      {/* Sign in / connected state */}
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.4 }}
        className="w-full max-w-sm"
      >
        <div className="flex flex-col items-center gap-4">
          {rowboatState.isConnected ? (
            <div className="flex items-center gap-2 text-green-600 dark:text-green-400">
              <CheckCircle2 className="size-5" />
              <span className="text-sm font-medium">Connected to Rowboat</span>
            </div>
          ) : null}
          <Button
            onClick={() => {
              if (rowboatState.isConnected) {
                state.setOnboardingPath('rowboat')
                state.setCurrentStep(2)
                return
              }
              state.setOnboardingPath('rowboat')
              state.startConnect('rowboat')
            }}
            size="lg"
            className="w-full h-12 text-base font-medium"
            disabled={rowboatState.isConnecting}
          >
            {rowboatState.isConnecting ? (
              <><Loader2 className="size-5 animate-spin mr-2" />Waiting for sign in...</>
            ) : rowboatState.isConnected ? (
              "Continue with Rowboat"
            ) : (
              "Sign in with Rowboat"
            )}
          </Button>

          {codexAvailable && (
            <>
              <div className="flex w-full items-center gap-3 text-xs text-muted-foreground">
                <div className="h-px flex-1 bg-border" />
                <span>or</span>
                <div className="h-px flex-1 bg-border" />
              </div>
              <div className="w-full rounded-xl border bg-muted/30 p-4 text-left">
                <div className="flex items-center gap-3 mb-3">
                  <div className="flex size-10 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
                    <OpenAIIcon />
                  </div>
                  <div>
                    <div className="text-sm font-semibold">ChatGPT / Codex</div>
                    <div className="text-xs text-muted-foreground">Use your ChatGPT subscription as the provider</div>
                  </div>
                </div>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    className="flex-1"
                    onClick={() => {
                      if (codexState.isConnected) {
                        state.setOnboardingPath('chatgpt-codex')
                        state.setCurrentStep(2)
                        return
                      }
                      state.setOnboardingPath('chatgpt-codex')
                      state.startConnect('chatgpt-codex')
                    }}
                    disabled={codexState.isConnecting}
                  >
                    {codexState.isConnecting ? <Loader2 className="size-4 animate-spin mr-2" /> : null}
                    {codexState.isConnected ? 'Continue' : 'Browser login'}
                  </Button>
                  {!codexState.isConnected && (
                    <Button
                      variant="ghost"
                      onClick={() => {
                        state.setOnboardingPath('chatgpt-codex')
                        state.startDeviceConnect('chatgpt-codex')
                      }}
                      disabled={codexState.isConnecting}
                    >
                      Device code
                    </Button>
                  )}
                </div>
                {codexState.isConnecting && (
                  <p className="mt-2 text-xs text-muted-foreground">
                    Complete ChatGPT sign-in in your browser or enter the device code, then return here.
                  </p>
                )}
              </div>
            </>
          )}
        </div>
      </motion.div>

      {/* BYOK link */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.5 }}
        className="mt-8"
      >
        <button
          onClick={() => {
            state.setOnboardingPath('byok')
            state.setCurrentStep(1)
          }}
          className="text-sm text-muted-foreground hover:text-foreground transition-colors underline underline-offset-4 decoration-muted-foreground/30 hover:decoration-foreground/50"
        >
          I want to bring my own API key
        </button>
      </motion.div>
    </div>
  )
}
