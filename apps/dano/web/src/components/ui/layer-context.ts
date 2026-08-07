import { getContext, setContext } from "svelte";

export type ModalLayer = "dialog" | "lightbox";
type LayerOwner = "base" | ModalLayer;
type FloatingLayer = "popover" | "tooltip";

const layerOwnerKey = Symbol("dano-layer-owner");

export function setLayerOwner(owner: ModalLayer): void {
	setContext(layerOwnerKey, owner);
}

export function getModalLayer(): ModalLayer {
	const owner = getContext<LayerOwner>(layerOwnerKey) ?? "base";
	return owner === "base" ? "dialog" : owner;
}

export function getFloatingLayer(layer: FloatingLayer): string {
	const owner = getContext<LayerOwner>(layerOwnerKey) ?? "base";
	return owner === "base" ? layer : `${owner}-${layer}`;
}
