"use client";
"use no memo";

import { Button } from "@dashboard/ui/components/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuTrigger,
} from "@dashboard/ui/components/dropdown-menu";
import { Input } from "@dashboard/ui/components/input";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow as UiTableRow,
} from "@dashboard/ui/components/table";
import { cn } from "@dashboard/ui/lib/utils";
import {
	type ColumnDef,
	type ColumnFiltersState,
	type FilterFn,
	flexRender,
	getCoreRowModel,
	getFilteredRowModel,
	getPaginationRowModel,
	getSortedRowModel,
	type PaginationState,
	type RowSelectionState,
	type SortingState,
	useReactTable,
} from "@tanstack/react-table";
import {
	ChevronDownIcon,
	ChevronLeftIcon,
	ChevronRightIcon,
	CircleXIcon,
	DownloadIcon,
	SearchIcon,
	SlidersHorizontalIcon,
} from "lucide-react";
import {
	Children,
	type ComponentPropsWithoutRef,
	cloneElement,
	isValidElement,
	type KeyboardEvent,
	type MouseEvent,
	type ReactNode,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { toast } from "sonner";

type AppLocale = "en-US";
type Translate = (
	key: string,
	values?: Record<string, number | string>
) => string;

const tableTranslations: Record<string, string> = {
	"common.all": "All",
	"common.clearSearch": "Clear search",
	"common.default": "Default",
	"common.edit": "Edit",
	"common.export": "Export",
	"common.sort": "Sort",
	"dataTable.empty.filtered": "No matching records.",
	"dataTable.empty.rows": "No records yet.",
	"dataTable.exported": "{count} row(s) exported.",
	"dataTable.filtered": "filtered",
	"dataTable.goNext": "Go to next page",
	"dataTable.goPrevious": "Go to previous page",
	"dataTable.page": "Page {current} of {total}",
	"dataTable.recordCount": "{count} records",
	"dataTable.records": "Records",
	"dataTable.rowsPerPage": "Rows per page",
	"dataTable.searchAria": "Search records",
	"dataTable.searchPlaceholder": "Search records...",
	"dataTable.selectAll": "Select all visible rows",
	"dataTable.selectRow": "Select {id}",
	"dataTable.selected": "{selected} of {count} row(s) selected.",
	"dataTable.showing": "Showing {visible} of {count}{filtered} records.",
	"service.table.defaultDescription": "Manage records from the current view.",
};

const translateServiceText = (_locale: AppLocale, value: string): string =>
	value;

const useI18n = (): { locale: AppLocale; t: Translate } => ({
	locale: "en-US",
	t: (key, values = {}) => {
		let text = tableTranslations[key] ?? key;
		for (const [name, value] of Object.entries(values)) {
			text = text.replaceAll(`{${name}}`, String(value));
		}
		return text;
	},
});

export interface DataTableRow {
	actions?: ReactNode;
	cells: ReactNode[];
	columnValues?: Partial<Record<string, string>>;
	detailAriaLabel?: string;
	id: string;
	onClick?: () => void;
	searchText?: string;
}

interface ServiceTableRow {
	actions?: ReactNode;
	cells: ReactNode[];
	detailAriaLabel?: string;
	id: string;
	onClick?: () => void;
	search: string;
	values: string[];
}

interface ServiceTableFilterConfig {
	columnId: string;
	label: string;
	options: string[];
}

type TableColumnAlignment = "center" | "left" | "right";

interface DataTableProps {
	columnAlignments?: Partial<Record<string, TableColumnAlignment>>;
	columns: string[];
	description?: null | string;
	filterLabels?: string[];
	headerAction?: ReactNode;
	hideTitleCount?: boolean;
	onSelectedRowIdChange?: (rowId: string) => void;
	rows: DataTableRow[];
	selectedRowId?: string;
	title?: string;
}

const compactButtonClass = "rounded-lg";
const panelClass =
	"rounded-xl bg-card text-card-foreground shadow-none ring-1 ring-foreground/10";
const selectionColumnClass = "w-12 min-w-12 max-w-12 text-center align-middle";

const nonFileNameCharactersPattern = /[^a-z0-9]+/gi;
const edgeDashPattern = /^-|-$/g;
const csvEscapingPattern = /[",\n\r]/;
const filterLabelSeparatorPattern = /[^a-z0-9]+/g;
const serviceTableColumnIdPattern = /^column-(\d+)$/;
const serviceTableColumnAlignmentClasses: Record<TableColumnAlignment, string> =
	{
		center: "text-center",
		left: "text-left",
		right: "text-right",
	};

export function DataTable({
	columnAlignments = {},
	columns,
	description,
	filterLabels = ["Status", "Date"],
	headerAction,
	hideTitleCount = false,
	onSelectedRowIdChange,
	rows,
	selectedRowId = "",
	title,
}: DataTableProps) {
	const { locale, t } = useI18n();
	const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
	const [exportFeedback, setExportFeedback] = useState("");
	const [sorting, setSorting] = useState<SortingState>([]);
	const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);
	const [globalFilter, setGlobalFilter] = useState("");
	const [pagination, setPagination] = useState<PaginationState>({
		pageIndex: 0,
		pageSize: 10,
	});
	const tableIdentity = useMemo(
		() => [title ?? "", ...columns, ...filterLabels].join("::"),
		[columns, filterLabels, title]
	);
	const isSingleRowSelection = onSelectedRowIdChange !== undefined;
	const rowIds = useMemo(() => new Set(rows.map((row) => row.id)), [rows]);
	let activeRowSelection = rowSelection;

	if (isSingleRowSelection) {
		activeRowSelection =
			selectedRowId && rowIds.has(selectedRowId)
				? { [selectedRowId]: true }
				: {};
	}
	const hasRowActions = rows.some((row) => row.actions !== undefined);
	const tableRows = useMemo(
		() => toServiceTableRows({ columns, rows }),
		[columns, rows]
	);
	const displayColumns = useMemo(
		() => columns.map((column) => translateServiceText(locale, column)),
		[columns, locale]
	);
	const filterConfigs = useMemo(
		() =>
			getServiceTableFilterConfigs({
				columns,
				filterLabels,
				locale,
				rows: tableRows,
			}),
		[columns, filterLabels, locale, tableRows]
	);
	const tableColumns = useMemo(
		() =>
			getServiceTableColumns(
				columns,
				displayColumns,
				hasRowActions,
				t,
				locale,
				isSingleRowSelection
			),
		[columns, displayColumns, hasRowActions, isSingleRowSelection, locale, t]
	);
	const table = useReactTable({
		columns: tableColumns,
		data: tableRows,
		enableMultiRowSelection: !isSingleRowSelection,
		enableRowSelection: true,
		getCoreRowModel: getCoreRowModel(),
		getFilteredRowModel: getFilteredRowModel(),
		getPaginationRowModel: getPaginationRowModel(),
		getRowId: (row) => row.id,
		getSortedRowModel: getSortedRowModel(),
		globalFilterFn: serviceTableGlobalFilter,
		onColumnFiltersChange: setColumnFilters,
		onGlobalFilterChange: setGlobalFilter,
		onPaginationChange: setPagination,
		onRowSelectionChange: (updater) => {
			const nextSelection =
				typeof updater === "function" ? updater(activeRowSelection) : updater;

			if (!isSingleRowSelection) {
				setRowSelection(nextSelection);
				return;
			}

			const nextSelectedRowId =
				Object.keys(nextSelection).find((rowId) => nextSelection[rowId]) ?? "";

			onSelectedRowIdChange(nextSelectedRowId);
		},
		onSortingChange: setSorting,
		state: {
			columnFilters,
			globalFilter,
			pagination,
			rowSelection: activeRowSelection,
			sorting,
		},
	});

	useEffect(() => {
		const shouldResetTableState = tableIdentity.length > 0;

		if (!shouldResetTableState) {
			return;
		}

		setColumnFilters([]);
		setExportFeedback("");
		setGlobalFilter("");
		setPagination({ pageIndex: 0, pageSize: 10 });
		if (!isSingleRowSelection) {
			setRowSelection({});
		}
		setSorting([]);
	}, [isSingleRowSelection, tableIdentity]);

	const filteredRowCount = table.getFilteredRowModel().rows.length;
	const selectedRowCount = table.getFilteredSelectedRowModel().rows.length;
	const currentPage = table.getState().pagination.pageIndex + 1;
	const rowsPerPage = table.getState().pagination.pageSize;
	const pageCount = Math.max(table.getPageCount(), 1);
	const hasRows = tableRows.length > 0;
	const hasFilteredRows = filteredRowCount > 0;
	const primarySort = sorting.find((sort) => sort.id === "column-0");
	const sortValue = getSortMenuValue(primarySort);
	const normalizedSearchQuery = globalFilter.trim();
	const recordCountLabel =
		title === undefined
			? t("dataTable.recordCount", { count: rows.length })
			: translateServiceText(locale, title);
	const tableDescription =
		description === null
			? ""
			: translateServiceText(
					locale,
					description ?? t("service.table.defaultDescription")
				);

	const exportVisibleRows = () => {
		const visibleRows = table
			.getFilteredRowModel()
			.rows.map((row) => row.original);
		exportRowsToCsv({
			columns,
			rows: visibleRows,
			title: title ?? "service-records",
		});
		setExportFeedback(t("dataTable.exported", { count: visibleRows.length }));
	};

	return (
		<div className={`${panelClass} overflow-hidden`}>
			<div className="flex flex-col gap-4 px-6 py-4">
				<div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
					<div className="min-w-0">
						{hideTitleCount ? (
							<div className="mb-1 flex items-center gap-2">
								<span className="rounded-md border border-border bg-muted/35 px-2 py-0.5 font-medium text-foreground text-xs">
									{recordCountLabel}
								</span>
							</div>
						) : (
							<p className="font-medium text-base leading-none">
								{title === undefined
									? `${rows.length} ${t("dataTable.records")}`
									: translateServiceText(locale, title)}
							</p>
						)}
						{tableDescription ? (
							<p
								className={cn(
									"text-muted-foreground text-sm",
									hideTitleCount ? "" : "mt-1"
								)}
							>
								{tableDescription}
							</p>
						) : null}
					</div>
					<div className="flex flex-wrap items-center justify-end gap-2">
						{headerAction}
						<Button
							className={compactButtonClass}
							disabled={!hasFilteredRows}
							onClick={exportVisibleRows}
							size="sm"
							variant="outline"
						>
							<DownloadIcon data-icon="inline-start" />
							{t("common.export")}
						</Button>
					</div>
				</div>
				<div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
					<div className="flex flex-col gap-2 sm:flex-row sm:items-center">
						<div className="relative sm:w-[340px]">
							<SearchIcon className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
							<Input
								aria-label={t("dataTable.searchAria")}
								className="h-8 rounded-lg bg-background pr-8 pl-9"
								onChange={(event) => {
									table.setGlobalFilter(event.target.value);
									table.setPageIndex(0);
								}}
								placeholder={t("dataTable.searchPlaceholder")}
								value={globalFilter}
							/>
							{globalFilter ? (
								<button
									aria-label={t("common.clearSearch")}
									className="absolute top-1/2 right-2 inline-flex size-5 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
									onClick={() => {
										table.setGlobalFilter("");
										table.setPageIndex(0);
									}}
									type="button"
								>
									<CircleXIcon className="size-4" />
								</button>
							) : null}
						</div>
						{filterConfigs.map((filter) => (
							<FilterMenu
								config={filter}
								key={filter.columnId}
								onChange={(value) => {
									table
										.getColumn(filter.columnId)
										?.setFilterValue(value === "all" ? undefined : value);
									table.setPageIndex(0);
								}}
								value={
									(table.getColumn(filter.columnId)?.getFilterValue() as
										| string
										| undefined) ?? "all"
								}
							/>
						))}
					</div>
					<div className="flex flex-wrap gap-2">
						<SortMenu
							onChange={(value) => {
								if (value === "default") {
									table.setSorting([]);
								} else {
									table.setSorting([
										{ desc: value === "desc", id: "column-0" },
									]);
								}
								table.setPageIndex(0);
							}}
							value={sortValue}
						/>
					</div>
				</div>
			</div>
			<div className="overflow-x-auto overflow-y-hidden border-t">
				<Table className="min-w-[820px] **:data-[slot=table-cell]:px-6 **:data-[slot=table-head]:px-6 **:data-[slot=table-cell]:py-4">
					<TableHeader className="**:data-[slot=table-head]:h-11 **:data-[slot=table-head]:font-medium **:data-[slot=table-head]:text-foreground **:data-[slot=table-head]:text-sm">
						{table.getHeaderGroups().map((headerGroup) => (
							<UiTableRow key={headerGroup.id}>
								{headerGroup.headers.map((header) => (
									<TableHead
										className={cn(
											"h-11 px-6 font-medium",
											header.column.id === "select" ? selectionColumnClass : "",
											getServiceTableColumnAlignmentClass({
												columnAlignments,
												columnId: header.column.id,
												columns,
											})
										)}
										colSpan={header.colSpan}
										key={header.id}
									>
										{header.isPlaceholder
											? null
											: flexRender(
													header.column.columnDef.header,
													header.getContext()
												)}
									</TableHead>
								))}
							</UiTableRow>
						))}
					</TableHeader>
					<TableBody className="**:data-[slot=table-row]:border-border/50">
						{table.getRowModel().rows.length ? (
							table.getRowModel().rows.map((row) => (
								<UiTableRow
									aria-label={row.original.detailAriaLabel}
									className={cn(
										row.original.onClick
											? "cursor-pointer hover:bg-muted/45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/35"
											: "hover:bg-transparent"
									)}
									data-state={row.getIsSelected() ? "selected" : undefined}
									key={row.id}
									onClick={
										row.original.onClick
											? (event) =>
													handleClickableRowPointerEvent(event, row.original)
											: undefined
									}
									onKeyDown={
										row.original.onClick
											? (event) =>
													handleClickableRowKeyboardEvent(event, row.original)
											: undefined
									}
									tabIndex={row.original.onClick ? 0 : undefined}
								>
									{row.getVisibleCells().map((cell) => (
										<TableCell
											className={cn(
												"px-6 py-4",
												cell.column.id === "select" ? selectionColumnClass : "",
												getServiceTableColumnAlignmentClass({
													columnAlignments,
													columnId: cell.column.id,
													columns,
												})
											)}
											key={cell.id}
										>
											{flexRender(
												cell.column.columnDef.cell,
												cell.getContext()
											)}
										</TableCell>
									))}
								</UiTableRow>
							))
						) : (
							<UiTableRow>
								<TableCell
									className="h-24 text-center text-muted-foreground"
									colSpan={table.getVisibleLeafColumns().length}
								>
									{hasRows
										? t("dataTable.empty.filtered")
										: t("dataTable.empty.rows")}
								</TableCell>
							</UiTableRow>
						)}
					</TableBody>
				</Table>
			</div>
			<div className="flex flex-col gap-3 px-6 py-4 text-muted-foreground text-sm lg:flex-row lg:items-center lg:justify-between">
				<div className="flex flex-col gap-1">
					<p>
						{t("dataTable.selected", {
							count: filteredRowCount,
							selected: selectedRowCount,
						})}
					</p>
					{exportFeedback ? <p>{exportFeedback}</p> : null}
				</div>
				<div className="flex flex-wrap items-center gap-3">
					<label className="flex items-center gap-2">
						<span>{t("dataTable.rowsPerPage")}</span>
						<select
							aria-label={t("dataTable.rowsPerPage")}
							className="h-8 rounded-lg border bg-background px-2 text-foreground text-sm outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
							name="rows-per-page"
							onChange={(event) => {
								table.setPageSize(Number(event.target.value));
							}}
							value={rowsPerPage}
						>
							{[10, 20, 30, 40, 50].map((pageSize) => (
								<option key={pageSize} value={pageSize}>
									{pageSize}
								</option>
							))}
						</select>
					</label>
					<p>
						{t("dataTable.showing", {
							count: filteredRowCount,
							filtered: normalizedSearchQuery
								? ` ${t("dataTable.filtered")}`
								: "",
							visible: table.getRowModel().rows.length,
						})}
					</p>
					<p>
						{t("dataTable.page", { current: currentPage, total: pageCount })}
					</p>
					<div className="flex items-center gap-2">
						<Button
							aria-label={t("dataTable.goPrevious")}
							className={compactButtonClass}
							disabled={!table.getCanPreviousPage()}
							onClick={() => table.previousPage()}
							size="icon-sm"
							variant="outline"
						>
							<ChevronLeftIcon className="size-4" />
						</Button>
						<Button
							aria-label={t("dataTable.goNext")}
							className={compactButtonClass}
							disabled={!table.getCanNextPage()}
							onClick={() => table.nextPage()}
							size="icon-sm"
							variant="outline"
						>
							<ChevronRightIcon className="size-4" />
						</Button>
					</div>
				</div>
			</div>
		</div>
	);
}

function FilterMenu({
	config,
	onChange,
	value,
}: {
	config: ServiceTableFilterConfig;
	onChange: (value: string) => void;
	value: string;
}) {
	const { locale, t } = useI18n();
	const activeOption =
		config.options.find((option) => option === value) ?? "All";
	const displayActiveOption = translateServiceText(locale, activeOption);

	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				render={
					<Button
						className={cn(
							"h-8 rounded-lg bg-background text-sm",
							value === "all" ? "" : "border-primary text-foreground"
						)}
						size="sm"
						variant="outline"
					/>
				}
			>
				{config.label}
				<ChevronDownIcon data-icon="inline-end" />
				{value === "all" ? null : (
					<span className="ml-1 text-muted-foreground">
						· {displayActiveOption}
					</span>
				)}
			</DropdownMenuTrigger>
			<DropdownMenuContent align="start" className="w-44 bg-card">
				<DropdownMenuRadioGroup onValueChange={onChange} value={value}>
					<DropdownMenuRadioItem closeOnClick value="all">
						{t("common.all")}
					</DropdownMenuRadioItem>
					{config.options.map((option) => (
						<DropdownMenuRadioItem closeOnClick key={option} value={option}>
							{translateServiceText(locale, option)}
						</DropdownMenuRadioItem>
					))}
				</DropdownMenuRadioGroup>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

function getSortMenuValue(sort: SortingState[number] | undefined) {
	if (!sort) {
		return "default";
	}

	if (sort.desc) {
		return "desc";
	}

	return "asc";
}

function getSortMenuLabel(value: string) {
	if (value === "asc") {
		return "A-Z";
	}

	if (value === "desc") {
		return "Z-A";
	}

	return "Default";
}

function SortMenu({
	onChange,
	value,
}: {
	onChange: (value: string) => void;
	value: string;
}) {
	const { t } = useI18n();
	const sortLabel = getSortMenuLabel(value);
	const displaySortLabel =
		sortLabel === "Default" ? t("common.default") : sortLabel;

	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				render={
					<Button
						className={cn(
							"h-8 rounded-lg bg-background text-sm",
							value === "default" ? "" : "border-primary text-foreground"
						)}
						size="sm"
						variant="outline"
					/>
				}
			>
				<SlidersHorizontalIcon data-icon="inline-start" />
				{t("common.sort")}
				<span className="ml-1 text-muted-foreground">· {displaySortLabel}</span>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" className="w-40 bg-card">
				<DropdownMenuRadioGroup onValueChange={onChange} value={value}>
					<DropdownMenuRadioItem closeOnClick value="default">
						{t("common.default")}
					</DropdownMenuRadioItem>
					<DropdownMenuRadioItem closeOnClick value="asc">
						A-Z
					</DropdownMenuRadioItem>
					<DropdownMenuRadioItem closeOnClick value="desc">
						Z-A
					</DropdownMenuRadioItem>
				</DropdownMenuRadioGroup>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

function TableSelectionCheckbox({
	indeterminate = false,
	...props
}: ComponentPropsWithoutRef<"input"> & { indeterminate?: boolean }) {
	const checkboxRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		if (checkboxRef.current) {
			checkboxRef.current.indeterminate = indeterminate;
		}
	}, [indeterminate]);

	return (
		<input
			className="block size-4 rounded border bg-background accent-primary disabled:cursor-not-allowed disabled:opacity-40"
			ref={checkboxRef}
			type="checkbox"
			{...props}
		/>
	);
}

function handleClickableRowPointerEvent(
	event: MouseEvent<HTMLTableRowElement>,
	row: ServiceTableRow
) {
	if (isInteractiveRowEventTarget(event.target)) {
		return;
	}

	row.onClick?.();
}

function handleClickableRowKeyboardEvent(
	event: KeyboardEvent<HTMLTableRowElement>,
	row: ServiceTableRow
) {
	if (event.key !== "Enter" && event.key !== " ") {
		return;
	}

	if (isInteractiveRowEventTarget(event.target)) {
		return;
	}

	event.preventDefault();
	row.onClick?.();
}

function isInteractiveRowEventTarget(target: EventTarget | null) {
	return (
		target instanceof Element &&
		target.closest(
			"a, button, input, select, textarea, summary, [role='button'], [role='checkbox'], [data-row-action]"
		) !== null
	);
}

function getNodeText(node: ReactNode): string {
	if (node === null || node === undefined || typeof node === "boolean") {
		return "";
	}

	if (typeof node === "string" || typeof node === "number") {
		return String(node);
	}

	if (Array.isArray(node)) {
		return node.map(getNodeText).join(" ");
	}

	if (isValidElement(node)) {
		const props = node.props as { children?: ReactNode };

		return getNodeText(props.children);
	}

	return "";
}

function localizeTableCell(node: ReactNode, locale: AppLocale): ReactNode {
	if (typeof node === "string") {
		return translateServiceText(locale, node);
	}

	if (typeof node === "number") {
		return node;
	}

	if (Array.isArray(node)) {
		return node.map((child) => localizeTableCell(child, locale));
	}

	if (isValidElement<{ children?: ReactNode }>(node)) {
		const children = node.props.children;

		if (children === undefined) {
			return node;
		}

		return cloneElement(node, {
			children: Children.map(children, (child) =>
				localizeTableCell(child, locale)
			),
		});
	}

	return node;
}

function getDataTableRowValues({
	columns,
	row,
}: {
	columns: string[];
	row: DataTableRow;
}) {
	return row.cells.map((cell, index) => {
		const column = columns[index];

		if (!column) {
			return getNodeText(cell);
		}

		return row.columnValues?.[column] ?? getNodeText(cell);
	});
}

function getRowSearchText(row: DataTableRow, values: string[]) {
	return [row.id, row.searchText ?? "", ...values].join(" ").toLowerCase();
}

function toServiceTableRows({
	columns,
	rows,
}: {
	columns: string[];
	rows: DataTableRow[];
}): ServiceTableRow[] {
	return rows.map((row) => {
		const values = getDataTableRowValues({ columns, row });

		return {
			actions: row.actions,
			cells: row.cells,
			detailAriaLabel: row.detailAriaLabel,
			id: row.id,
			onClick: row.onClick,
			search: getRowSearchText(row, values),
			values,
		};
	});
}

function serviceTableGlobalFilter(
	row: { original: ServiceTableRow },
	_columnId: string,
	filterValue: unknown
) {
	const query = String(filterValue ?? "")
		.trim()
		.toLowerCase();

	if (!query) {
		return true;
	}

	return row.original.search.includes(query);
}

const serviceTableColumnFilter: FilterFn<ServiceTableRow> = (
	row,
	columnId,
	filterValue
) => {
	const selectedValue = String(filterValue ?? "");

	if (!selectedValue || selectedValue === "all") {
		return true;
	}

	const cellValue = String(row.getValue(columnId) ?? "");

	return cellValue === selectedValue;
};

function getServiceTableFilterConfigs({
	columns,
	filterLabels,
	locale,
	rows,
}: {
	columns: string[];
	filterLabels: string[];
	locale: AppLocale;
	rows: ServiceTableRow[];
}): ServiceTableFilterConfig[] {
	return filterLabels
		.map((label) => {
			const columnIndex = getFilterColumnIndex({ columns, label });

			if (columnIndex === -1) {
				return null;
			}

			const options = Array.from(
				new Set(
					rows
						.map((row) => row.values[columnIndex]?.trim() ?? "")
						.filter(Boolean)
				)
			).sort((first, second) =>
				translateServiceText(locale, first).localeCompare(
					translateServiceText(locale, second),
					locale,
					{ sensitivity: "base" }
				)
			);

			if (options.length === 0) {
				return null;
			}

			return {
				columnId: `column-${columnIndex}`,
				label: translateServiceText(locale, label),
				options,
			};
		})
		.filter((config): config is ServiceTableFilterConfig => config !== null);
}

function getFilterColumnIndex({
	columns,
	label,
}: {
	columns: string[];
	label: string;
}) {
	const normalizedLabel = normalizeFilterLabel(label);
	const normalizedLabelWithoutJobPrefix = normalizedLabel.startsWith("job")
		? normalizedLabel.slice(3)
		: normalizedLabel;
	const exactMatchIndex = columns.findIndex(
		(column) => normalizeFilterLabel(column) === normalizedLabel
	);

	if (exactMatchIndex !== -1) {
		return exactMatchIndex;
	}

	if (normalizedLabelWithoutJobPrefix) {
		const contextualExactMatchIndex = columns.findIndex(
			(column) =>
				normalizeFilterLabel(column) === normalizedLabelWithoutJobPrefix
		);

		if (contextualExactMatchIndex !== -1) {
			return contextualExactMatchIndex;
		}
	}

	const includedMatchIndex = columns.findIndex((column) => {
		const normalizedColumn = normalizeFilterLabel(column);

		return (
			normalizedColumn.includes(normalizedLabel) ||
			(normalizedColumn.length > 2 &&
				normalizedLabel.includes(normalizedColumn))
		);
	});

	if (includedMatchIndex !== -1) {
		return includedMatchIndex;
	}

	const labelTokens = getFilterTokens(label);

	return columns.findIndex((column) =>
		getFilterTokens(column).some((token) => labelTokens.includes(token))
	);
}

function normalizeFilterLabel(value: string) {
	return value.toLowerCase().replaceAll(filterLabelSeparatorPattern, "");
}

function getFilterTokens(value: string) {
	return value
		.toLowerCase()
		.split(filterLabelSeparatorPattern)
		.filter((token) => token.length > 2);
}

function getServiceTableColumnAlignmentClass({
	columnAlignments,
	columnId,
	columns,
}: {
	columnAlignments: Partial<Record<string, TableColumnAlignment>>;
	columnId: string;
	columns: string[];
}) {
	if (columnId === "actions") {
		return serviceTableColumnAlignmentClasses.right;
	}

	const dataColumnIndex = getServiceTableDataColumnIndex(columnId);

	if (dataColumnIndex === null) {
		return "";
	}

	const column = columns[dataColumnIndex];

	if (!column) {
		return "";
	}

	const alignment = columnAlignments[column];

	return alignment ? serviceTableColumnAlignmentClasses[alignment] : "";
}

function getServiceTableDataColumnIndex(columnId: string) {
	const match = serviceTableColumnIdPattern.exec(columnId);

	if (!match?.[1]) {
		return null;
	}

	return Number(match[1]);
}

function getServiceTableColumns(
	columns: string[],
	displayColumns: string[],
	hasActions: boolean,
	t: Translate,
	locale: AppLocale,
	isSingleRowSelection = false
): ColumnDef<ServiceTableRow>[] {
	const tableColumns: ColumnDef<ServiceTableRow>[] = [
		{
			cell: ({ row }) => (
				<div className="flex min-h-5 items-center justify-center">
					<TableSelectionCheckbox
						aria-label={t("dataTable.selectRow", { id: row.original.id })}
						checked={row.getIsSelected()}
						disabled={!row.getCanSelect()}
						onChange={row.getToggleSelectedHandler()}
					/>
				</div>
			),
			enableSorting: false,
			header: ({ table }) =>
				isSingleRowSelection ? null : (
					<div className="flex min-h-5 items-center justify-center">
						<TableSelectionCheckbox
							aria-label={t("dataTable.selectAll")}
							checked={table.getIsAllPageRowsSelected()}
							disabled={table.getRowModel().rows.length === 0}
							indeterminate={
								table.getIsSomePageRowsSelected() &&
								!table.getIsAllPageRowsSelected()
							}
							onChange={table.getToggleAllPageRowsSelectedHandler()}
						/>
					</div>
				),
			id: "select",
			size: 48,
		},
		...columns.map<ColumnDef<ServiceTableRow>>((column, index) => ({
			accessorFn: (row) => row.values[index] ?? "",
			cell: ({ row }) =>
				localizeTableCell(
					row.original.cells[index] ?? row.original.values[index] ?? "",
					locale
				),
			filterFn: serviceTableColumnFilter,
			header: displayColumns[index] ?? column,
			id: `column-${index}`,
		})),
	];

	if (hasActions) {
		tableColumns.push({
			cell: ({ row }) => row.original.actions,
			enableSorting: false,
			header: t("common.edit"),
			id: "actions",
		});
	}

	return tableColumns;
}

function exportRowsToCsv({
	columns,
	rows,
	title,
}: {
	columns: string[];
	rows: ServiceTableRow[];
	title: string;
}) {
	const header = [...columns, "Row ID"];
	const csvRows = [
		header.map(escapeCsvValue).join(","),
		...rows.map((row) => [...row.values, row.id].map(escapeCsvValue).join(",")),
	];
	const csvBlob = new Blob([csvRows.join("\n")], {
		type: "text/csv;charset=utf-8",
	});
	const url = URL.createObjectURL(csvBlob);
	const link = document.createElement("a");
	link.href = url;
	link.download = `${toFileName(title)}.csv`;
	document.body.append(link);
	link.click();
	link.remove();
	URL.revokeObjectURL(url);
	toast.success(`${rows.length} row(s) exported.`);
}

function escapeCsvValue(value: string) {
	const normalizedValue = value.replaceAll('"', '""');

	if (csvEscapingPattern.test(normalizedValue)) {
		return `"${normalizedValue}"`;
	}

	return normalizedValue;
}

export function toFileName(value: string) {
	return (
		value
			.toLowerCase()
			.replace(nonFileNameCharactersPattern, "-")
			.replace(edgeDashPattern, "") || "service-records"
	);
}
