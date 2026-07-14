"use client";

import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { cn } from "@dashboard/ui/lib/utils";
import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";

const sidebarVariants = cva(
	"hidden h-svh shrink-0 overflow-hidden border-sidebar-border border-r bg-card text-card-foreground shadow-sm transition-[width] duration-200 md:flex md:flex-col",
	{
		variants: {
			collapsible: {
				icon: "",
				none: "",
			},
			state: {
				collapsed: "w-[76px]",
				expanded: "w-[304px]",
			},
		},
		defaultVariants: {
			collapsible: "icon",
			state: "expanded",
		},
	}
);

function Sidebar({
	className,
	collapsible,
	state,
	...props
}: React.ComponentProps<"aside"> & VariantProps<typeof sidebarVariants>) {
	return (
		<aside
			className={cn(sidebarVariants({ collapsible, state }), className)}
			data-collapsible={collapsible}
			data-slot="sidebar"
			data-state={state}
			{...props}
		/>
	);
}

function SidebarHeader({ className, ...props }: React.ComponentProps<"div">) {
	return (
		<div
			className={cn(
				"flex items-center gap-4 px-4 py-4 lg:px-6 lg:py-7",
				className
			)}
			data-slot="sidebar-header"
			{...props}
		/>
	);
}

function SidebarContent({ className, ...props }: React.ComponentProps<"div">) {
	return (
		<div
			className={cn(
				"flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-4 py-3",
				className
			)}
			data-slot="sidebar-content"
			{...props}
		/>
	);
}

function SidebarFooter({ className, ...props }: React.ComponentProps<"div">) {
	return (
		<div
			className={cn("mt-auto p-4", className)}
			data-slot="sidebar-footer"
			{...props}
		/>
	);
}

function SidebarGroup({ className, ...props }: React.ComponentProps<"nav">) {
	return (
		<nav
			className={cn("flex flex-col gap-2", className)}
			data-slot="sidebar-group"
			{...props}
		/>
	);
}

function SidebarGroupLabel({
	className,
	...props
}: React.ComponentProps<"div">) {
	return (
		<div
			className={cn(
				"px-3 font-semibold text-muted-foreground text-sm",
				className
			)}
			data-slot="sidebar-group-label"
			{...props}
		/>
	);
}

function SidebarMenu({ className, ...props }: React.ComponentProps<"ul">) {
	return (
		<ul
			className={cn("flex flex-col gap-1", className)}
			data-slot="sidebar-menu"
			{...props}
		/>
	);
}

function SidebarMenuItem({ className, ...props }: React.ComponentProps<"li">) {
	return (
		<li
			className={cn("list-none", className)}
			data-slot="sidebar-menu-item"
			{...props}
		/>
	);
}

function SidebarMenuButton({
	active,
	className,
	collapsed,
	render,
	...props
}: useRender.ComponentProps<"a"> & {
	active?: boolean;
	collapsed?: boolean;
}) {
	return useRender({
		defaultTagName: "a",
		props: mergeProps<"a">(
			{
				className: cn(
					"flex h-10 items-center gap-3 rounded-xl px-4 text-left font-medium text-base transition-[background-color,color,box-shadow] hover:bg-muted/60 hover:text-foreground",
					active
						? "bg-muted text-foreground shadow-xs ring-1 ring-foreground/5"
						: "text-foreground/70",
					collapsed && "justify-center px-0",
					className
				),
			},
			{
				"data-active": active ? "true" : undefined,
				"data-collapsed": collapsed ? "true" : undefined,
				...props,
			} as React.ComponentProps<"a">
		),
		render,
		state: {
			active,
			collapsed,
			slot: "sidebar-menu-button",
		},
	});
}

export {
	Sidebar,
	SidebarContent,
	SidebarFooter,
	SidebarGroup,
	SidebarGroupLabel,
	SidebarHeader,
	SidebarMenu,
	SidebarMenuButton,
	SidebarMenuItem,
};
