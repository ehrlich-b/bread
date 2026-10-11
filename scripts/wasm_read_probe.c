// Isolated four-state table READ kernel; this is not a simulator.
// Build with installed LLVM (no libc, glue runtime or downloaded toolchain):
// clang --target=wasm32 -nostdlib -O3 -Wl,--no-entry -Wl,--export=read_batch
//   -Wl,--export-memory -Wl,--initial-memory=262144
//   scripts/wasm_read_probe.c -o .scratch/wasm-read.wasm
unsigned read_batch(unsigned char *values, const unsigned *offsets,
                    const unsigned *inputs, const unsigned char *counts,
                    const unsigned *words, unsigned *proposed,
                    unsigned components, unsigned iterations, unsigned clock_net) {
  unsigned checksum = 0;
  for (unsigned step = 0; step < iterations; step++) {
    values[clock_net] ^= 1;
    for (unsigned c = 0; c < components; c++) {
      unsigned offset = offsets[c];
      if (!offset) continue;
      unsigned base = c * 5, count = counts[c];
      unsigned vector = (count > 0 ? values[inputs[base]] : 0)
        | (count > 1 ? values[inputs[base + 1]] << 2 : 0)
        | (count > 2 ? values[inputs[base + 2]] << 4 : 0)
        | (count > 3 ? values[inputs[base + 3]] << 6 : 0);
      unsigned word = words[offset + vector];
      proposed[c] = word;
      checksum += word;
    }
  }
  return checksum;
}
