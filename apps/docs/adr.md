---
title: Decisions
description: "The architecture decision records behind arcadekit: what was decided, and why."
---

<script setup lang="ts">
import { withBase } from "vitepress";

import { data as adrs } from "./.vitepress/adrs.data.ts";
</script>

# Decisions

The kit's architecture decision records. Each one says what was decided and why, so a later change knows what it is changing. The entries' pages link to the ones behind them.

<table>
  <thead>
    <tr>
      <th>Record</th>
      <th>Decision</th>
      <th>Status</th>
    </tr>
  </thead>
  <tbody>
    <tr v-for="adr of adrs" :key="adr.number">
      <td class="adr-number"><a :href="withBase(adr.link)">ADR-{{ adr.number }}</a></td>
      <td>{{ adr.title }}</td>
      <td>{{ adr.status }}</td>
    </tr>
  </tbody>
</table>

<style scoped>
.adr-number {
  white-space: nowrap;
}
</style>
