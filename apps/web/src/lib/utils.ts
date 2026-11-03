import { type ClassValue, clsx } from "clsx"
import { twMerge } from "tailwind-merge"

/** shadcn's class name helper: conditional classes, with later Tailwind classes winning. */
export const cn = (...inputs: Array<ClassValue>) => twMerge(clsx(inputs))
