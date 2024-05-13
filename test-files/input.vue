<template>
  <div>
    <p>Hello {{ someConst }}!</p>
    <MyComponent v-bind:prop="someConst" v-custom:[someConst]="otherConst" />
    <div v-bind="{ ...props }" :array="[...arr1]"></div>
    <div v-bind="{ ...props, ...otherProps }" :array="[...arr1, ...arr2]"></div>
    <div v-bind="{ parentProps: props }"></div>
    <div v-for="_ of props.array">array</div>
    <div v-for="_ in (props.array as any)">array</div>
    <VisLine
      :x="(d: Data, i: number) => i"
      :y="(d: Data) => d[category]"
   /> 
  </div>
</template>

<style scoped>
p {
  color: red;
}
</style>

<script lang="ts">
console.log("This is the non-setup script");
</script>

<script lang="ts" setup>
import MyComponent from "MyComponent.vue";
import { someConst, otherConst } from "some-module";
import type { AssetURLOptions } from "@vue/compiler-sfc";
import { type Props } from "./types";

const props = withDefaults(
  defineProps<
    {
      prop: string;
      array: string[];
    } & Props &
      AssetURLOptions
  >(),
  {
    prop: "default",
    array: [],
  }
);

const emit = defineEmits<{
  (e: "change", id: number): void;
  (e: "update", value: string): void;
}>();

let x: string;

// This comment should be kept

// This comment should be deleted
// Ditto for this
interface Foo {
  // This should go too
  bar: number;
}

// This comment should also be kept
defineExpose({
  foo: "bar",
});
const otherProps = {};
const arr1: number[] = [];
const arr2: string[] = [];
</script>
