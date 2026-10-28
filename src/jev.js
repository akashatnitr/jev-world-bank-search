// TypeSafe System One API (Jev): state + typed questions -> calibrated answers.
// https://docs.typesafe.ai/api
import { config } from './config.js';

const URL_ = 'https://api.typesafe.ai/v1/systemone';

export async function jev(state, questions, { retries = 3, signal } = {}) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(URL_, {
      method: 'POST',
      signal,
      headers: { Authorization: `Bearer ${config.jevKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ state, model: config.jevModel, questions }),
    });
    if (res.ok) return (await res.json()).answers;
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt >= retries) {
      throw new Error(`Jev ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
    const wait = Number(res.headers.get('retry-after')) * 1000 || 400 * 2 ** attempt;
    await new Promise((r) => setTimeout(r, wait));
  }
}

export const noul = (instructions, criteria) => ({ type: 'noul', instructions, ...(criteria && { criteria }) });
export const choice = (instructions, criteria) => ({ type: 'choice', instructions, criteria });
