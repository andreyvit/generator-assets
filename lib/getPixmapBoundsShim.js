/*
 * Copyright (c) 2013 Adobe Systems Incorporated. All rights reserved.
 *  
 * Permission is hereby granted, free of charge, to any person obtaining a
 * copy of this software and associated documentation files (the "Software"), 
 * to deal in the Software without restriction, including without limitation 
 * the rights to use, copy, modify, merge, publish, distribute, sublicense, 
 * and/or sell copies of the Software, and to permit persons to whom the 
 * Software is furnished to do so, subject to the following conditions:
 *  
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *  
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, 
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER 
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING 
 * FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER 
 * DEALINGS IN THE SOFTWARE.
 * 
 */

(function () {
    "use strict";

    function completeInstall(generator, Q, xpm) {

        generator.getPixmap = function (documentId, layerId, settings) {
            if (arguments.length !== 3) {
                console.warn("Call to getPixmap with " + arguments.length +
                    " instead of 3 arguments - outdated plugin?");
            }
            var self            = this,
                jsDeferred      = Q.defer(),
                pixmapDeferred  = Q.defer(),
                overallDeferred = Q.defer(),
                params          = {
                    documentId: documentId,
                    layerId:    layerId,
                    inputRect:  settings.inputRect,
                    outputRect: settings.outputRect,
                    scaleX:     settings.scaleX || 1,
                    scaleY:     settings.scaleY || 1,
                    bounds:     true,
                    boundsOnly: settings.boundsOnly,
                    useSmartScaling: settings.useSmartScaling || false,
                    includeAncestorMasks: settings.includeAncestorMasks || false
                };

            // Because of PS communication irregularities in different versions of PS, it's very complicated to
            // know when we're "done" getting responses from executing this JSX file. In various scenarios, the
            // evaluation of the JSX file produces some subset of the following responses in some *arbitrary* order:
            //
            // - A javascript message that is a stringification of an Action Descriptor object
            //  (i.e. "[ActionDescriptor]") -- this should always come back
            // - A javascript message that is a strinification of a JSON object that contains bounds -- currently
            //   this always comes back because "bounds" is hardcoded to "true" in the params list
            // - A pixmap message -- this should come back if and only if boundsOnly is false.
            //
            // The two deferreds at the top of this function (jsDeferred and pixmapDeferred) resolve when we've
            // received all of the expected messages of the respective type. Because we might get multiple
            // JS messages, we use a (series of) helper deferreds in the closure below, and only resolve the main
            // jsDeferred when we have what we need. 
            //
            // overallDeferred (the promise of which is returned by this function) resolves when both jsDeferred and
            // pixmapDeferred resolve.
            //
            // Note that this method could be slightly more efficient if we didn't create the pixmapDeffered in cases
            // where it wasn't necessary. But the logic is much simpler if we just create it and then resolve it
            // in cases where we don't need it. When the day comes that Generator is slow because we create one
            // extra deferred every time we generate an image, we'll optimize this.

            self._executeJSXFile("./jsx/getLayerPixmap.jsx", params).then(
                function (id) {
                    function installNextHelperJSDeferred() {
                        var helperDeferred = Q.defer();
                        self._jsMessageDeferreds[id] = helperDeferred;

                        helperDeferred.promise.done(
                            function (val) {
                                if (val instanceof Object && val.hasOwnProperty("bounds")) {
                                    // got what we were looking for, so we're done with the series
                                    // of helper deferred
                                    jsDeferred.resolve(val);
                                } else {
                                    // haven't yet got what we're looking for, add a new deferred
                                    installNextHelperJSDeferred();
                                }
                            },
                            function (err) {
                                jsDeferred.reject(err);
                            }
                        );
                    }

                    // Start the series of helper deferreds
                    installNextHelperJSDeferred();

                    // All but the very last of the helper deferreds will get automatically garbage collected.
                    // When the overall jsDeferred resolves or rejects, we remove the last helper deferred
                    // so it gets garbage collected too.
                    jsDeferred.promise.finally(function () { delete self._jsMessageDeferreds[id]; });

                    // Get ready for any incoming pixmap, and make sure we garbage collect the pixmapDeferred
                    // in all cases.
                    self._pixmapMessageDeferreds[id] = pixmapDeferred;
                    pixmapDeferred.promise.finally(function () { delete self._pixmapMessageDeferreds[id]; });
                }, function (err) {
                    jsDeferred.reject(err);
                    pixmapDeferred.reject(err);
                }
            );

            // Resolve the pixmapDeferred now if we aren't actually expecting a pixmap
            if (params.boundsOnly) {
                pixmapDeferred.resolve();
            }

            Q.all([jsDeferred.promise, pixmapDeferred.promise]).done(
                function (vals) {
                    if (params.boundsOnly && vals[0] && vals[0].bounds) {
                        overallDeferred.resolve(vals[0]);
                    } else if (vals[0] && vals[0].bounds && vals[1]) {
                        var pixmapBuffer = vals[1];
                        var pixmap = xpm.Pixmap(pixmapBuffer);
                        pixmap.bounds = vals[0].bounds;
                        overallDeferred.resolve(pixmap);
                    } else {
                        var errStr = "Unexpected response from PS in getLayerPixmap: jsDeferred val: " +
                            JSON.stringify(vals[0]) +
                            ", pixmapDeferred val: " +
                            vals[1] ? "truthy" : "falsy";
                        overallDeferred.reject(new Error(errStr));
                    }
                }, function (err) {
                    overallDeferred.reject(err);
                }
            );

            return overallDeferred.promise;

        };

        generator.__GET_PIXMAP_BOUNDS_SHIM_FOR_2_0_2__ = true;

        console.warn("Shim installed successfully");
    }

    function install(generator, force) {
        var doInstall = false,
            generatorConfig = null,
            semver = null;

        if (force) {
            doInstall = true;
            console.warn("Installing getPixmap bounds shim because it was explicitly forced");
        } else {

            if (generator.__GET_PIXMAP_BOUNDS_SHIM_FOR_2_0_2__) {
                console.warn("Skipping getPixmap bounds shim because it is already present");
            } else {

                try {
                    generatorConfig = module.parent.parent.require("../package.json");
                    semver = module.parent.parent.require("semver");
                } catch (generatorRequireVersioningException) {
                    doInstall = true;
                    console.warn("Installing getPixmap bounds shim, but was unable to check Generator's version " +
                        "(semver or generator config failed to load):\n", generatorRequireVersioningException);
                }

                if (!doInstall && semver && generatorConfig) {
                    if (!generatorConfig.version) {
                        doInstall = true;
                        console.warn("Installing getPixmap bounds shim, " +
                            "but Generator's package.json does not contain a version");
                    } else if (semver.lt(generatorConfig.version, "2.0.2")) {
                        doInstall = true;
                        console.warn("Installing getPixmap bounds shim because " +
                            "Generator version of %s is less than 2.0.2",
                            generatorConfig.version);
                    } else {
                        doInstall = false;
                        console.warn("Skipping getPixmap bounds shim installation because Generator version of %s " +
                            "is at least as new as 2.0.2", generatorConfig.version);
                    }
                }
            }
        }

        if (doInstall) {
            var Q = null,
                xpm = null;

            try {
                Q = module.parent.parent.require("q");
                xpm = module.parent.parent.require("./xpm");
            } catch (generatorRequireModulesException) {
                console.warn("Failed to install getPixmap bounds shim, could not load modules 'q' and 'xpm':\n",
                    generatorRequireModulesException);
            }

            if (Q && xpm) {
                completeInstall(generator, Q, xpm);
            }
        }

    }
    
    exports.install = install;

}());