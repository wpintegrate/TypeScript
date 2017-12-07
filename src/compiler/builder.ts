/// <reference path="program.ts" />

/*@internal*/
namespace ts {
    export function getFileEmitOutput(program: Program, sourceFile: SourceFile, emitOnlyDtsFiles: boolean,
        cancellationToken?: CancellationToken, customTransformers?: CustomTransformers): EmitOutput {
        const outputFiles: OutputFile[] = [];
        const emitResult = program.emit(sourceFile, writeFile, cancellationToken, emitOnlyDtsFiles, customTransformers);
        return { outputFiles, emitSkipped: emitResult.emitSkipped };

        function writeFile(fileName: string, text: string, writeByteOrderMark: boolean) {
            outputFiles.push({ name: fileName, writeByteOrderMark, text });
        }
    }

    /**
     * Internal Builder to get files affected by another file
     */
    export interface InternalBuilder extends BaseBuilder {
        /**
         * Gets the files affected by the file path
         * This api is only for internal use
         */
        /*@internal*/
        getFilesAffectedBy(programOfThisState: Program, path: Path, cancellationToken: CancellationToken): ReadonlyArray<SourceFile>;
    }

    /**
     * Create the internal builder to get files affected by sourceFile
     */
    export function createInternalBuilder(host: BuilderHost): InternalBuilder {
        return createBuilder(host, BuilderKind.BuilderKindInternal);
    }

    export enum BuilderKind {
        BuilderKindInternal,
        BuilderKindSemanticDiagnostics,
        BuilderKindEmitAndSemanticDiagnostics
    }

    /**
     * Information about the source file: Its version and optional signature from last emit
     */
    interface FileInfo {
        version: string;
        signature?: string;
    }

    /**
     * Referenced files with values for the keys as referenced file's path to be true
     */
    type ReferencedSet = ReadonlyMap<true>;

    function hasSameKeys<T, U>(map1: ReadonlyMap<T> | undefined, map2: ReadonlyMap<U> | undefined) {
        if (map1 === undefined) {
            return map2 === undefined;
        }
        if (map2 === undefined) {
            return map1 === undefined;
        }
        // Has same size and every key is present in both maps
        return map1.size === map2.size && !forEachEntry(map1, (_value, key) => !map2.has(key));
    }

    export function createBuilder(host: BuilderHost, builderKind: BuilderKind.BuilderKindInternal): InternalBuilder;
    export function createBuilder(host: BuilderHost, builderKind: BuilderKind.BuilderKindSemanticDiagnostics): SemanticDiagnosticsBuilder;
    export function createBuilder(host: BuilderHost, builderKind: BuilderKind.BuilderKindEmitAndSemanticDiagnostics): EmitAndSemanticDiagnosticsBuilder;
    export function createBuilder(host: BuilderHost, builderKind: BuilderKind) {
        /**
         * Create the canonical file name for identity
         */
        const getCanonicalFileName = createGetCanonicalFileName(host.useCaseSensitiveFileNames());
        /**
         * Computing hash to for signature verification
         */
        const computeHash = host.createHash || identity;

        /**
         * Information of the file eg. its version, signature etc
         */
        const fileInfos = createMap<FileInfo>();

        /**
         * true if module emit is enabled
         */
        let isModuleEmit: boolean;

        /**
         * Contains the map of ReferencedSet=Referenced files of the file if module emit is enabled
         * Otherwise undefined
         */
        let referencedMap: Map<ReferencedSet> | undefined;

        /**
         * Get the files affected by the source file.
         * This is dependent on whether its a module emit or not and hence function expression
         */
        let getEmitDependentFilesAffectedBy: (programOfThisState: Program, sourceFileWithUpdatedShape: SourceFile, cacheToUpdateSignature: Map<string>, cancellationToken: CancellationToken | undefined) => ReadonlyArray<SourceFile>;

        /**
         * Cache of semantic diagnostics for files with their Path being the key
         */
        const semanticDiagnosticsPerFile = createMap<ReadonlyArray<Diagnostic>>();

        /**
         * The map has key by source file's path that has been changed
         */
        const changedFilesSet = createMap<true>();

        /**
         * Map of files that have already called update signature.
         * That means hence forth these files are assumed to have
         * no change in their signature for this version of the program
         */
        const hasCalledUpdateShapeSignature = createMap<true>();

        /**
         * Cache of all files excluding default library file for the current program
         */
        let allFilesExcludingDefaultLibraryFile: ReadonlyArray<SourceFile> | undefined;

        /**
         * Set of affected files being iterated
         */
        let affectedFiles: ReadonlyArray<SourceFile> | undefined;
        /**
         * Current index to retrieve affected file from
         */
        let affectedFilesIndex = 0;
        /**
         * Current changed file for iterating over affected files
         */
        let currentChangedFilePath: Path | undefined;
        /**
         * Map of file signatures, with key being file path, calculated while getting current changed file's affected files
         * These will be commited whenever the iteration through affected files of current changed file is complete
         */
        const currentAffectedFilesSignatures = createMap<string>();
        /**
         * Already seen affected files
         */
        const seenAffectedFiles = createMap<true>();

        switch (builderKind) {
            case BuilderKind.BuilderKindInternal:
                return getInternalBuilder();
            case BuilderKind.BuilderKindSemanticDiagnostics:
                return getSemanticDiagnosticsBuilder();
            case BuilderKind.BuilderKindEmitAndSemanticDiagnostics:
                return getEmitAndSemanticDiagnosticsBuilder();
            default:
                notImplemented();
        }

        function getInternalBuilder(): InternalBuilder {
            return {
                updateProgram,
                getFilesAffectedBy,
                getAllDependencies
            };
        }

        function getSemanticDiagnosticsBuilder(): SemanticDiagnosticsBuilder {
            return {
                updateProgram,
                getAllDependencies,
                getSemanticDiagnosticsOfNextAffectedFile,
                getSemanticDiagnostics
            };
        }

        function getEmitAndSemanticDiagnosticsBuilder(): EmitAndSemanticDiagnosticsBuilder {
            return {
                updateProgram,
                getAllDependencies,
                emitNextAffectedFile,
                getSemanticDiagnostics
            };
        }

        /**
         * Update current state to reflect new program
         * Updates changed files, references, file infos etc
         */
        function updateProgram(newProgram: Program) {
            const newProgramHasModuleEmit = newProgram.getCompilerOptions().module !== ModuleKind.None;
            const oldReferencedMap = referencedMap;
            if (isModuleEmit !== newProgramHasModuleEmit) {
                // Changes in the module emit, clear out everything and initialize as if first time

                // Clear file information and semantic diagnostics
                fileInfos.clear();
                semanticDiagnosticsPerFile.clear();

                // Clear changed files and affected files information
                changedFilesSet.clear();
                affectedFiles = undefined;
                currentChangedFilePath = undefined;
                currentAffectedFilesSignatures.clear();

                // Update the reference map creation
                referencedMap = newProgramHasModuleEmit ? createMap<ReferencedSet>() : undefined;

                // Update the module emit
                isModuleEmit = newProgramHasModuleEmit;
                getEmitDependentFilesAffectedBy = isModuleEmit ?
                    getFilesAffectedByUpdatedShapeWhenModuleEmit :
                    getFilesAffectedByUpdatedShapeWhenNonModuleEmit;
            }
            else {
                if (currentChangedFilePath) {
                    // Remove the diagnostics for all the affected files since we should resume the state such that
                    // the whole iteration on currentChangedFile never happened
                    affectedFiles.map(sourceFile => semanticDiagnosticsPerFile.delete(sourceFile.path));
                    affectedFiles = undefined;
                    currentAffectedFilesSignatures.clear();
                }
                else {
                    // Verify the sanity of old state
                    Debug.assert(!affectedFiles && !currentAffectedFilesSignatures.size, "Cannot reuse if only few affected files of currentChangedFile were iterated");
                }
                Debug.assert(!forEachEntry(changedFilesSet, (_value, path) => semanticDiagnosticsPerFile.has(path)), "Semantic diagnostics shouldnt be available for changed files");
            }

            // Clear datas that cant be retained beyond previous state
            seenAffectedFiles.clear();
            hasCalledUpdateShapeSignature.clear();
            allFilesExcludingDefaultLibraryFile = undefined;

            // Create the reference map and update changed files
            for (const sourceFile of newProgram.getSourceFiles()) {
                const version = sourceFile.version;
                const newReferences = referencedMap && getReferencedFiles(newProgram, sourceFile);
                const oldInfo = fileInfos.get(sourceFile.path);
                let oldReferences: ReferencedSet;

                // Register changed file if its new file or we arent reusing old state
                if (!oldInfo) {
                    // New file: Set the file info
                    fileInfos.set(sourceFile.path, { version });
                    changedFilesSet.set(sourceFile.path, true);
                }
                // versions dont match
                else if (oldInfo.version !== version ||
                    // Referenced files changed
                    !hasSameKeys(newReferences, (oldReferences = oldReferencedMap && oldReferencedMap.get(sourceFile.path))) ||
                    // Referenced file was deleted in the new program
                    newReferences && forEachEntry(newReferences, (_value, path) => !newProgram.getSourceFileByPath(path as Path) && fileInfos.has(path))) {

                    // Changed file: Update the version, set as changed file
                    oldInfo.version = version;
                    changedFilesSet.set(sourceFile.path, true);

                    // All changed files need to re-evaluate its semantic diagnostics
                    semanticDiagnosticsPerFile.delete(sourceFile.path);
                }

                // Set the references
                if (newReferences) {
                    referencedMap.set(sourceFile.path, newReferences);
                }
                else if (referencedMap) {
                    referencedMap.delete(sourceFile.path);
                }
            }

            // For removed files, remove the semantic diagnostics and file info
            if (fileInfos.size > newProgram.getSourceFiles().length) {
                fileInfos.forEach((_value, path) => {
                    if (!newProgram.getSourceFileByPath(path as Path)) {
                        fileInfos.delete(path);
                        semanticDiagnosticsPerFile.delete(path);
                        if (referencedMap) {
                            referencedMap.delete(path);
                        }
                    }
                });
            }
        }

        /**
         * Gets the files affected by the path from the program
         */
        function getFilesAffectedBy(programOfThisState: Program, path: Path, cancellationToken: CancellationToken | undefined, cacheToUpdateSignature?: Map<string>): ReadonlyArray<SourceFile> {
            // Since the operation could be cancelled, the signatures are always stored in the cache
            // They will be commited once it is safe to use them
            // eg when calling this api from tsserver, if there is no cancellation of the operation
            // In the other cases the affected files signatures are commited only after the iteration through the result is complete
            const signatureCache = cacheToUpdateSignature || createMap();
            const sourceFile = programOfThisState.getSourceFileByPath(path);
            if (!sourceFile) {
                return emptyArray;
            }

            if (!updateShapeSignature(programOfThisState, sourceFile, signatureCache, cancellationToken)) {
                return [sourceFile];
            }

            const result = getEmitDependentFilesAffectedBy(programOfThisState, sourceFile, signatureCache, cancellationToken);
            if (!cacheToUpdateSignature) {
                // Commit all the signatures in the signature cache
                updateSignaturesFromCache(signatureCache);
            }
            return result;
        }

        /**
         * Updates the signatures from the cache
         * This should be called whenever it is safe to commit the state of the builder
         */
        function updateSignaturesFromCache(signatureCache: Map<string>) {
            signatureCache.forEach((signature, path) => {
                fileInfos.get(path).signature = signature;
                hasCalledUpdateShapeSignature.set(path, true);
            });
        }

        /**
         * This function returns the next affected file to be processed.
         * Note that until doneAffected is called it would keep reporting same result
         * This is to allow the callers to be able to actually remove affected file only when the operation is complete
         * eg. if during diagnostics check cancellation token ends up cancelling the request, the affected file should be retained
         */
        function getNextAffectedFile(programOfThisState: Program, cancellationToken: CancellationToken | undefined): SourceFile | Program | undefined {
            while (true) {
                if (affectedFiles) {
                    while (affectedFilesIndex < affectedFiles.length) {
                        const affectedFile = affectedFiles[affectedFilesIndex];
                        if (!seenAffectedFiles.has(affectedFile.path)) {
                            // Set the next affected file as seen and remove the cached semantic diagnostics
                            semanticDiagnosticsPerFile.delete(affectedFile.path);
                            return affectedFile;
                        }
                        seenAffectedFiles.set(affectedFile.path, true);
                        affectedFilesIndex++;
                    }

                    // Remove the changed file from the change set
                    changedFilesSet.delete(currentChangedFilePath);
                    currentChangedFilePath = undefined;
                    // Commit the changes in file signature
                    updateSignaturesFromCache(currentAffectedFilesSignatures);
                    currentAffectedFilesSignatures.clear();
                    affectedFiles = undefined;
                }

                // Get next changed file
                const nextKey = changedFilesSet.keys().next();
                if (nextKey.done) {
                    // Done
                    return undefined;
                }

                const compilerOptions = programOfThisState.getCompilerOptions();
                // With --out or --outFile all outputs go into single file
                // so operations are performed directly on program, return program
                if (compilerOptions.outFile || compilerOptions.out) {
                    Debug.assert(semanticDiagnosticsPerFile.size === 0);
                    return programOfThisState;
                }

                // Get next batch of affected files
                currentAffectedFilesSignatures.clear();
                affectedFiles = getFilesAffectedBy(programOfThisState, nextKey.value as Path, cancellationToken, currentAffectedFilesSignatures);
                currentChangedFilePath = nextKey.value as Path;
                semanticDiagnosticsPerFile.delete(currentChangedFilePath);
                affectedFilesIndex = 0;
            }
        }

        /**
         * This is called after completing operation on the next affected file.
         * The operations here are postponed to ensure that cancellation during the iteration is handled correctly
         */
        function doneWithAffectedFile(programOfThisState: Program, affected: SourceFile | Program) {
            if (affected === programOfThisState) {
                changedFilesSet.clear();
            }
            else {
                seenAffectedFiles.set((<SourceFile>affected).path, true);
                affectedFilesIndex++;
            }
        }

        /**
         * Returns the result with affected file
         */
        function toAffectedFileResult<T>(programOfThisState: Program, result: T, affected: SourceFile | Program): AffectedFileResult<T> {
            doneWithAffectedFile(programOfThisState, affected);
            return { result, affected };
        }

        /**
         * Emits the next affected file, and returns the EmitResult along with source files emitted
         * Returns undefined when iteration is complete
         */
        function emitNextAffectedFile(programOfThisState: Program, writeFileCallback: WriteFileCallback, cancellationToken?: CancellationToken, customTransformers?: CustomTransformers): AffectedFileResult<EmitResult> {
            const affectedFile = getNextAffectedFile(programOfThisState, cancellationToken);
            if (!affectedFile) {
                // Done
                return undefined;
            }
            else if (affectedFile === programOfThisState) {
                // When whole program is affected, do emit only once (eg when --out or --outFile is specified)
                return toAffectedFileResult(
                    programOfThisState,
                    programOfThisState.emit(/*targetSourceFile*/ undefined, writeFileCallback, cancellationToken, /*emitOnlyDtsFiles*/ false, customTransformers),
                    programOfThisState
                );
            }

            // Emit the affected file
            const targetSourceFile = affectedFile as SourceFile;
            return toAffectedFileResult(
                programOfThisState,
                programOfThisState.emit(targetSourceFile, writeFileCallback, cancellationToken, /*emitOnlyDtsFiles*/ false, customTransformers),
                targetSourceFile
            );
        }

        /**
         * Return the semantic diagnostics for the next affected file or undefined if iteration is complete
         * If provided ignoreSourceFile would be called before getting the diagnostics and would ignore the sourceFile if the returned value was true
         */
        function getSemanticDiagnosticsOfNextAffectedFile(programOfThisState: Program, cancellationToken?: CancellationToken, ignoreSourceFile?: (sourceFile: SourceFile) => boolean): AffectedFileResult<ReadonlyArray<Diagnostic>> {
            while (true) {
                const affectedFile = getNextAffectedFile(programOfThisState, cancellationToken);
                if (!affectedFile) {
                    // Done
                    return undefined;
                }
                else if (affectedFile === programOfThisState) {
                    // When whole program is affected, get all semantic diagnostics (eg when --out or --outFile is specified)
                    return toAffectedFileResult(
                        programOfThisState,
                        programOfThisState.getSemanticDiagnostics(/*targetSourceFile*/ undefined, cancellationToken),
                        programOfThisState
                    );
                }

                // Get diagnostics for the affected file if its not ignored
                const targetSourceFile = affectedFile as SourceFile;
                if (ignoreSourceFile && ignoreSourceFile(targetSourceFile)) {
                    // Get next affected file
                    doneWithAffectedFile(programOfThisState, targetSourceFile);
                    continue;
                }

                return toAffectedFileResult(
                    programOfThisState,
                    getSemanticDiagnosticsOfFile(programOfThisState, targetSourceFile, cancellationToken),
                    targetSourceFile
                );
            }
        }

        /**
         * Gets the semantic diagnostics from the program corresponding to this state of file (if provided) or whole program
         * The semantic diagnostics are cached and managed here
         * Note that it is assumed that the when asked about semantic diagnostics, the file has been taken out of affected files
         */
        function getSemanticDiagnostics(programOfThisState: Program, sourceFile?: SourceFile, cancellationToken?: CancellationToken): ReadonlyArray<Diagnostic> {
            Debug.assert(!affectedFiles || affectedFiles[affectedFilesIndex - 1] !== sourceFile || !semanticDiagnosticsPerFile.has(sourceFile.path));
            const compilerOptions = programOfThisState.getCompilerOptions();
            if (compilerOptions.outFile || compilerOptions.out) {
                Debug.assert(semanticDiagnosticsPerFile.size === 0);
                // We dont need to cache the diagnostics just return them from program
                return programOfThisState.getSemanticDiagnostics(sourceFile, cancellationToken);
            }

            if (sourceFile) {
                return getSemanticDiagnosticsOfFile(programOfThisState, sourceFile, cancellationToken);
            }

            let diagnostics: Diagnostic[];
            for (const sourceFile of programOfThisState.getSourceFiles()) {
                diagnostics = addRange(diagnostics, getSemanticDiagnosticsOfFile(programOfThisState, sourceFile, cancellationToken));
            }
            return diagnostics || emptyArray;
        }

        /**
         * Gets the semantic diagnostics either from cache if present, or otherwise from program and caches it
         * Note that it is assumed that the when asked about semantic diagnostics, the file has been taken out of affected files/changed file set
         */
        function getSemanticDiagnosticsOfFile(program: Program, sourceFile: SourceFile, cancellationToken?: CancellationToken): ReadonlyArray<Diagnostic> {
            const path = sourceFile.path;
            const cachedDiagnostics = semanticDiagnosticsPerFile.get(path);
            // Report the semantic diagnostics from the cache if we already have those diagnostics present
            if (cachedDiagnostics) {
                return cachedDiagnostics;
            }

            // Diagnostics werent cached, get them from program, and cache the result
            const diagnostics = program.getSemanticDiagnostics(sourceFile, cancellationToken);
            semanticDiagnosticsPerFile.set(path, diagnostics);
            return diagnostics;
        }

        /**
         * Get all the dependencies of the sourceFile
         */
        function getAllDependencies(programOfThisState: Program, sourceFile: SourceFile): string[] {
            const compilerOptions = programOfThisState.getCompilerOptions();
            // With --out or --outFile all outputs go into single file, all files depend on each other
            if (compilerOptions.outFile || compilerOptions.out) {
                return programOfThisState.getSourceFiles().map(getFileName);
            }

            // If this is non module emit, or its a global file, it depends on all the source files
            if (!isModuleEmit || (!isExternalModule(sourceFile) && !containsOnlyAmbientModules(sourceFile))) {
                return programOfThisState.getSourceFiles().map(getFileName);
            }

            // Get the references, traversing deep from the referenceMap
            Debug.assert(!!referencedMap);
            const seenMap = createMap<true>();
            const queue = [sourceFile.path];
            while (queue.length) {
                const path = queue.pop();
                if (!seenMap.has(path)) {
                    seenMap.set(path, true);
                    const references = referencedMap.get(path);
                    if (references) {
                        const iterator = references.keys();
                        for (let { value, done } = iterator.next(); !done; { value, done } = iterator.next()) {
                            queue.push(value as Path);
                        }
                    }
                }
            }

            return flatMapIter(seenMap.keys(), path => {
                const file = programOfThisState.getSourceFileByPath(path as Path);
                if (file) {
                    return file.fileName;
                }
                return path;
            });
        }

        function getFileName(sourceFile: SourceFile) {
            return sourceFile.fileName;
        }

        /**
         * For script files that contains only ambient external modules, although they are not actually external module files,
         * they can only be consumed via importing elements from them. Regular script files cannot consume them. Therefore,
         * there are no point to rebuild all script files if these special files have changed. However, if any statement
         * in the file is not ambient external module, we treat it as a regular script file.
         */
        function containsOnlyAmbientModules(sourceFile: SourceFile) {
            for (const statement of sourceFile.statements) {
                if (!isModuleWithStringLiteralName(statement)) {
                    return false;
                }
            }
            return true;
        }

        /**
         * Returns if the shape of the signature has changed since last emit
         * Note that it also updates the current signature as the latest signature for the file
         */
        function updateShapeSignature(program: Program, sourceFile: SourceFile, cacheToUpdateSignature: Map<string>, cancellationToken: CancellationToken | undefined) {
            Debug.assert(!!sourceFile);

            // If we have cached the result for this file, that means hence forth we should assume file shape is uptodate
            if (hasCalledUpdateShapeSignature.has(sourceFile.path) || cacheToUpdateSignature.has(sourceFile.path)) {
                return false;
            }

            const info = fileInfos.get(sourceFile.path);
            Debug.assert(!!info);

            const prevSignature = info.signature;
            let latestSignature: string;
            if (sourceFile.isDeclarationFile) {
                latestSignature = sourceFile.version;
            }
            else {
                const emitOutput = getFileEmitOutput(program, sourceFile, /*emitOnlyDtsFiles*/ true, cancellationToken);
                if (emitOutput.outputFiles && emitOutput.outputFiles.length > 0) {
                    latestSignature = computeHash(emitOutput.outputFiles[0].text);
                }
                else {
                    latestSignature = prevSignature;
                }
            }
            cacheToUpdateSignature.set(sourceFile.path, latestSignature);

            return !prevSignature || latestSignature !== prevSignature;
        }

        /**
         * Gets the referenced files for a file from the program with values for the keys as referenced file's path to be true
         */
        function getReferencedFiles(program: Program, sourceFile: SourceFile): Map<true> | undefined {
            let referencedFiles: Map<true> | undefined;

            // We need to use a set here since the code can contain the same import twice,
            // but that will only be one dependency.
            // To avoid invernal conversion, the key of the referencedFiles map must be of type Path
            if (sourceFile.imports && sourceFile.imports.length > 0) {
                const checker: TypeChecker = program.getTypeChecker();
                for (const importName of sourceFile.imports) {
                    const symbol = checker.getSymbolAtLocation(importName);
                    if (symbol && symbol.declarations && symbol.declarations[0]) {
                        const declarationSourceFile = getSourceFileOfNode(symbol.declarations[0]);
                        if (declarationSourceFile) {
                            addReferencedFile(declarationSourceFile.path);
                        }
                    }
                }
            }

            const sourceFileDirectory = getDirectoryPath(sourceFile.path);
            // Handle triple slash references
            if (sourceFile.referencedFiles && sourceFile.referencedFiles.length > 0) {
                for (const referencedFile of sourceFile.referencedFiles) {
                    const referencedPath = toPath(referencedFile.fileName, sourceFileDirectory, getCanonicalFileName);
                    addReferencedFile(referencedPath);
                }
            }

            // Handle type reference directives
            if (sourceFile.resolvedTypeReferenceDirectiveNames) {
                sourceFile.resolvedTypeReferenceDirectiveNames.forEach((resolvedTypeReferenceDirective) => {
                    if (!resolvedTypeReferenceDirective) {
                        return;
                    }

                    const fileName = resolvedTypeReferenceDirective.resolvedFileName;
                    const typeFilePath = toPath(fileName, sourceFileDirectory, getCanonicalFileName);
                    addReferencedFile(typeFilePath);
                });
            }

            return referencedFiles;

            function addReferencedFile(referencedPath: Path) {
                if (!referencedFiles) {
                    referencedFiles = createMap<true>();
                }
                referencedFiles.set(referencedPath, true);
            }
        }

        /**
         * Gets the files referenced by the the file path
         */
        function getReferencedByPaths(referencedFilePath: Path) {
            return mapDefinedIter(referencedMap.entries(), ([filePath, referencesInFile]) =>
                referencesInFile.has(referencedFilePath) ? filePath as Path : undefined
            );
        }

        /**
         * Gets all files of the program excluding the default library file
         */
        function getAllFilesExcludingDefaultLibraryFile(program: Program, firstSourceFile: SourceFile): ReadonlyArray<SourceFile> {
            // Use cached result
            if (allFilesExcludingDefaultLibraryFile) {
                return allFilesExcludingDefaultLibraryFile;
            }

            let result: SourceFile[];
            addSourceFile(firstSourceFile);
            for (const sourceFile of program.getSourceFiles()) {
                if (sourceFile !== firstSourceFile) {
                    addSourceFile(sourceFile);
                }
            }
            allFilesExcludingDefaultLibraryFile = result || emptyArray;
            return allFilesExcludingDefaultLibraryFile;

            function addSourceFile(sourceFile: SourceFile) {
                if (!program.isSourceFileDefaultLibrary(sourceFile)) {
                    (result || (result = [])).push(sourceFile);
                }
            }
        }

        /**
         * When program emits non modular code, gets the files affected by the sourceFile whose shape has changed
         */
        function getFilesAffectedByUpdatedShapeWhenNonModuleEmit(programOfThisState: Program, sourceFileWithUpdatedShape: SourceFile) {
            const compilerOptions = programOfThisState.getCompilerOptions();
            // If `--out` or `--outFile` is specified, any new emit will result in re-emitting the entire project,
            // so returning the file itself is good enough.
            if (compilerOptions && (compilerOptions.out || compilerOptions.outFile)) {
                return [sourceFileWithUpdatedShape];
            }
            return getAllFilesExcludingDefaultLibraryFile(programOfThisState, sourceFileWithUpdatedShape);
        }

        /**
         * When program emits modular code, gets the files affected by the sourceFile whose shape has changed
         */
        function getFilesAffectedByUpdatedShapeWhenModuleEmit(programOfThisState: Program, sourceFileWithUpdatedShape: SourceFile, cacheToUpdateSignature: Map<string>, cancellationToken: CancellationToken | undefined) {
            if (!isExternalModule(sourceFileWithUpdatedShape) && !containsOnlyAmbientModules(sourceFileWithUpdatedShape)) {
                return getAllFilesExcludingDefaultLibraryFile(programOfThisState, sourceFileWithUpdatedShape);
            }

            const compilerOptions = programOfThisState.getCompilerOptions();
            if (compilerOptions && (compilerOptions.isolatedModules || compilerOptions.out || compilerOptions.outFile)) {
                return [sourceFileWithUpdatedShape];
            }

            // Now we need to if each file in the referencedBy list has a shape change as well.
            // Because if so, its own referencedBy files need to be saved as well to make the
            // emitting result consistent with files on disk.
            const seenFileNamesMap = createMap<SourceFile>();

            // Start with the paths this file was referenced by
            seenFileNamesMap.set(sourceFileWithUpdatedShape.path, sourceFileWithUpdatedShape);
            const queue = getReferencedByPaths(sourceFileWithUpdatedShape.path);
            while (queue.length > 0) {
                const currentPath = queue.pop();
                if (!seenFileNamesMap.has(currentPath)) {
                    const currentSourceFile = programOfThisState.getSourceFileByPath(currentPath);
                    seenFileNamesMap.set(currentPath, currentSourceFile);
                    if (currentSourceFile && updateShapeSignature(programOfThisState, currentSourceFile, cacheToUpdateSignature, cancellationToken)) {
                        queue.push(...getReferencedByPaths(currentPath));
                    }
                }
            }

            // Return array of values that needs emit
            return flatMapIter(seenFileNamesMap.values(), value => value);
        }
    }
}

namespace ts {
    export interface EmitOutput {
        outputFiles: OutputFile[];
        emitSkipped: boolean;
    }

    export interface OutputFile {
        name: string;
        writeByteOrderMark: boolean;
        text: string;
    }

    export type AffectedFileResult<T> = { result: T; affected: SourceFile | Program; } | undefined;

    export interface BuilderHost {
        /**
         * return true if file names are treated with case sensitivity
         */
        useCaseSensitiveFileNames(): boolean;
        /**
         * If provided this would be used this hash instead of actual file shape text for detecting changes
         */
        createHash?: (data: string) => string;
    }

    /**
     * Builder to manage the program state changes
     */
    export interface BaseBuilder {
        /**
         * Updates the program in the builder to represent new state
         */
        updateProgram(newProgram: Program): void;

        /**
         * Get all the dependencies of the file
         */
        getAllDependencies(programOfThisState: Program, sourceFile: SourceFile): string[];
    }

    /**
     * The builder that caches the semantic diagnostics for the program and handles the changed files and affected files
     */
    export interface SemanticDiagnosticsBuilder extends BaseBuilder {
        /**
         * Gets the semantic diagnostics from the program for the next affected file and caches it
         * Returns undefined if the iteration is complete
         */
        getSemanticDiagnosticsOfNextAffectedFile(programOfThisState: Program, cancellationToken?: CancellationToken, ignoreSourceFile?: (sourceFile: SourceFile) => boolean): AffectedFileResult<ReadonlyArray<Diagnostic>>;

        /**
         * Gets the semantic diagnostics from the program corresponding to this state of file (if provided) or whole program
         * The semantic diagnostics are cached and managed here
         * Note that it is assumed that the when asked about semantic diagnostics through this API,
         * the file has been taken out of affected files so it is safe to use cache or get from program and cache the diagnostics
         */
        getSemanticDiagnostics(programOfThisState: Program, sourceFile?: SourceFile, cancellationToken?: CancellationToken): ReadonlyArray<Diagnostic>;
    }

    /**
     * The builder that can handle the changes in program and iterate through changed file to emit the files
     * The semantic diagnostics are cached per file and managed by clearing for the changed/affected files
     */
    export interface EmitAndSemanticDiagnosticsBuilder extends BaseBuilder {
        /**
         * Emits the next affected file's emit result (EmitResult and sourceFiles emitted) or returns undefined if iteration is complete
         */
        emitNextAffectedFile(programOfThisState: Program, writeFileCallback: WriteFileCallback, cancellationToken?: CancellationToken, customTransformers?: CustomTransformers): AffectedFileResult<EmitResult>;

        /**
         * Gets the semantic diagnostics from the program corresponding to this state of file (if provided) or whole program
         * The semantic diagnostics are cached and managed here
         * Note that it is assumed that the when asked about semantic diagnostics through this API,
         * the file has been taken out of affected files so it is safe to use cache or get from program and cache the diagnostics
         */
        getSemanticDiagnostics(programOfThisState: Program, sourceFile?: SourceFile, cancellationToken?: CancellationToken): ReadonlyArray<Diagnostic>;
    }

    /**
     * Create the builder to manage semantic diagnostics and cache them
     */
    export function createSemanticDiagnosticsBuilder(host: BuilderHost): SemanticDiagnosticsBuilder {
        return createBuilder(host, BuilderKind.BuilderKindSemanticDiagnostics);
    }

    /**
     * Create the builder that can handle the changes in program and iterate through changed files
     * to emit the those files and manage semantic diagnostics cache as well
     */
    export function createEmitAndSemanticDiagnosticsBuilder(host: BuilderHost): EmitAndSemanticDiagnosticsBuilder {
        return createBuilder(host, BuilderKind.BuilderKindEmitAndSemanticDiagnostics);
    }
}
