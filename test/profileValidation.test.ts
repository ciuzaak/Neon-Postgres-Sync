import test = require('node:test');
import assert = require('node:assert/strict');
import {
    validateProfileForm,
    hasErrors,
    PROFILE_TABLENAME_REGEX_SOURCE
} from '../src/profileValidation';

const valid = {
    name: 'my-profile',
    filePath: 'data.json',
    id: 'rec-1',
    tableName: 'json_records'
};

test('validateProfileForm returns no errors for a fully valid form', () => {
    const errors = validateProfileForm(valid, { existingNames: [] });
    assert.deepEqual(errors, {});
    assert.equal(hasErrors(errors), false);
});

test('validateProfileForm flags every empty required field', () => {
    const errors = validateProfileForm(
        { name: '  ', filePath: '', id: '', tableName: '' },
        { existingNames: [] }
    );
    assert.equal(errors.name, 'Name is required.');
    assert.equal(errors.filePath, 'File path is required.');
    assert.equal(errors.id, 'Record ID is required.');
    assert.equal(errors.tableName, 'Table name is required.');
    assert.equal(hasErrors(errors), true);
});

test('validateProfileForm rejects duplicate names but allows the original on edit', () => {
    const errorsDup = validateProfileForm(valid, { existingNames: ['my-profile', 'other'] });
    assert.equal(errorsDup.name, 'A profile with this name already exists.');

    const errorsRename = validateProfileForm(
        valid,
        { existingNames: ['my-profile', 'other'], originalName: 'my-profile' }
    );
    assert.equal(errorsRename.name, undefined);
});

test('validateProfileForm enforces SQL identifier shape on tableName', () => {
    for (const tableName of ['1bad', 'with space', 'a;b', 'schema.', '.table']) {
        const errors = validateProfileForm({ ...valid, tableName }, { existingNames: [] });
        assert.notEqual(errors.tableName, undefined, `expected error for "${tableName}"`);
    }
    for (const tableName of ['records', 'json_records', 'public.records', '_t1', 'Schema.Table_2']) {
        const errors = validateProfileForm({ ...valid, tableName }, { existingNames: [] });
        assert.equal(errors.tableName, undefined, `expected no error for "${tableName}"`);
    }
});

test('PROFILE_TABLENAME_REGEX_SOURCE is the same shape DatabaseService uses', () => {
    const re = new RegExp(PROFILE_TABLENAME_REGEX_SOURCE);
    assert.equal(re.test('public.records'), true);
    assert.equal(re.test('records; drop'), false);
});
