import { useState, useEffect, useCallback } from 'react';
import axios from 'axios';

/**
 * Shared payment gateway list.
 *
 * Which payment methods a form offers is configuration, not a hardcoded list, so
 * every payment screen reads it from here. The result is fetched once per page
 * load and shared between components, because several pages need it and each one
 * fetching separately would be wasteful and could disagree mid-session.
 */

// Module scope, so the cache outlives any single component.
let cache = null;
let inflight = null;

// Cash is always a valid fallback while the real list is still loading, so a
// form never renders an empty dropdown on first paint.
const FALLBACK = [{ value: 'cash', label: 'Cash' }];

export const usePaymentGateways = () => {
  const [state, setState] = useState(() =>
    cache
      ? { ...cache, loading: false, error: null }
      : { gateways: [], methods: FALLBACK, fallbackApplied: false, loading: true, error: null }
  );

  const load = useCallback(async (force = false) => {
    if (cache && !force) {
      setState({ ...cache, loading: false, error: null });
      return cache;
    }

    if (inflight && !force) return inflight;

    inflight = axios
      .get('/api/payment-gateways')
      .then(({ data }) => {
        cache = {
          gateways: data.gateways || [],
          // Trust the server's fallback rather than inventing one here, so the
          // form shows exactly what the backend will accept.
          methods: (data.enabled_methods || []).length
            ? data.enabled_methods
            : FALLBACK,
          fallbackApplied: !!data.fallback_applied,
          fallbackNote: data.fallback_note || null,
          // Enabled but not yet collectable. Settings shows this so switching one on
          // looks like it did nothing, when in fact the server withheld the method.
          suppressedUnwired: data.suppressed_unwired || 0,
          mpesaCallbackPlaceholder: !!data.mpesa_callback_placeholder
        };
        setState({ ...cache, loading: false, error: null });
        return cache;
      })
      .catch((error) => {
        // A failed fetch must not leave a form with no way to record a payment.
        setState((prev) => ({
          ...prev,
          loading: false,
          error: error.response?.data?.error || 'Could not load payment methods.'
        }));
        return null;
      })
      .finally(() => {
        inflight = null;
      });

    return inflight;
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  /** Methods as { value, label }, ready to map into <option>. */
  const options = state.methods;

  /** True when a given stored method is still accepted. */
  const isEnabled = useCallback(
    (value) => state.methods.some((m) => m.value === value),
    [state.methods]
  );

  /**
   * Keeps a stored method when it is still accepted, otherwise falls back to the
   * first enabled one.
   *
   * Without this, switching a gateway off in Settings leaves any open form holding
   * a value that is no longer among its own options: the select renders blank and
   * submits nothing, so the payment is recorded with a missing method. Preserving
   * a still-valid value means it never overrides a choice the user just made.
   */
  const pickDefault = useCallback(
    (current) =>
      state.methods.some((m) => m.value === current)
        ? current
        : (state.methods[0]?.value ?? FALLBACK[0].value),
    [state.methods]
  );

  return {
    ...state,
    options,
    isEnabled,
    pickDefault,
    reload: () => load(true)
  };
};

/** Drops the module cache, e.g. after signing out. */
export const clearPaymentGatewayCache = () => {
  cache = null;
  inflight = null;
};

export default usePaymentGateways;