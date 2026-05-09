export const PROFILE_TABLENAME_REGEX_SOURCE = '^[a-zA-Z_][a-zA-Z0-9_]*(\\.[a-zA-Z_][a-zA-Z0-9_]*)?$';
export const PROFILE_TABLENAME_RE = new RegExp(PROFILE_TABLENAME_REGEX_SOURCE);

export interface ProfileFormValues {
    name: string;
    filePath: string;
    id: string;
    tableName: string;
}

export interface ProfileFieldErrors {
    name?: string;
    filePath?: string;
    id?: string;
    tableName?: string;
}

export interface ValidateProfileOptions {
    existingNames: string[];
    originalName?: string;
}

export function validateProfileForm(
    values: ProfileFormValues,
    options: ValidateProfileOptions
): ProfileFieldErrors {
    const errors: ProfileFieldErrors = {};

    const name = values.name.trim();
    if (!name) {
        errors.name = 'Name is required.';
    } else {
        const others = options.existingNames.filter((n) => n !== options.originalName);
        if (others.includes(name)) {
            errors.name = 'A profile with this name already exists.';
        }
    }

    if (!values.filePath.trim()) {
        errors.filePath = 'File path is required.';
    }

    if (!values.id.trim()) {
        errors.id = 'Record ID is required.';
    }

    const tableName = values.tableName.trim();
    if (!tableName) {
        errors.tableName = 'Table name is required.';
    } else if (!PROFILE_TABLENAME_RE.test(tableName)) {
        errors.tableName = 'Only letters, numbers, and underscores. Optionally schema.table.';
    }

    return errors;
}

export function hasErrors(errors: ProfileFieldErrors): boolean {
    return Object.values(errors).some((v) => v !== undefined);
}
