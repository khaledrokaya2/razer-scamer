function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sleepCancellable(ms, checkCancellation = null, sliceMs = 250) {
  if (!checkCancellation) {
    await sleep(ms);
    return false;
  }

  let elapsed = 0;
  while (elapsed < ms) {
    if (checkCancellation()) {
      return true;
    }

    const step = Math.min(sliceMs, ms - elapsed);
    await sleep(step);
    elapsed += step;
  }

  return !!checkCancellation();
}

function getStaggerDelay(index, baseMs, jitterMs = 0) {
  const jitter = jitterMs > 0 ? Math.floor(Math.random() * (jitterMs + 1)) : 0;
  return (index * baseMs) + jitter;
}

module.exports = {
  sleep,
  sleepCancellable,
  getStaggerDelay
};
