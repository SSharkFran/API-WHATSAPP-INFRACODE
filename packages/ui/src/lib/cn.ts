import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Faz o merge seguro de classes utilitárias Tailwind no mesmo formato usado pelo shadcn/ui.
 */
export const cn = (...inputs: ClassValue[]): string => twMerge(clsx(inputs));
