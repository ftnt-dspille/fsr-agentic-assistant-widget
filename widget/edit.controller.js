'use strict';
(function () {
    angular
        .module('cybersponse')
        .controller('editAgenticAssistant142DevCtrl', editAgenticAssistant142DevCtrl);

    // Only the dashboard's $uibModal instantiates this controller (the inline
    // settings overlay ng-includes edit.html under the VIEW scope, whose own
    // save()/cancel() run there). The modal passes `config` and
    // `$uibModalInstance` as controller LOCALS, not injector services, so they
    // must be listed in $inject: $injector.get() throws for both and Save
    // silently does nothing. (KNOWLEDGEBASE.md 5.2)
    editAgenticAssistant142DevCtrl.$inject = ['$scope', '$uibModalInstance', 'config'];

    function editAgenticAssistant142DevCtrl($scope, $uibModalInstance, config) {

        $scope.config = config || {};
        $scope.save = function () { $uibModalInstance.close($scope.config); };
        $scope.cancel = function () { $uibModalInstance.dismiss('cancel'); };

        // ─── Config defaults ──────────────────────────────────────────────────
        if (!$scope.config) $scope.config = {};
        var c = $scope.config;
        if (!c.maxTurns)          c.maxTurns          = 10;
        if (c.enableStepVerify == null) c.enableStepVerify = false;
        if (c.showUsage == null)  c.showUsage         = true;
        if (!c.mockMode)          c.mockMode          = 'auto';
        if (!c.mockScenario)      c.mockScenario      = 'playbook_soc_demo';
        if (!c.mockSpeed)         c.mockSpeed         = 'real';
        if (!c.opener)            c.opener            = 'auto';
        // Same default as the chat controller (view.controller.js): 'auto' lets
        // the connector pick guided vs freeform by the model it runs.
        if (!c.createStrategy)    c.createStrategy    = 'auto';

        $scope.mockScenarios = [
            { value: 'playbook_soc_demo',   label: 'SOC demo (branching)' },
            { value: 'immediate_block_ip',  label: 'Immediate · block IP' },
            { value: 'conditional_block_ip', label: 'Immediate · block IP (conditional params)' },
            { value: 'immediate_quarantine', label: 'Immediate · quarantine host' },
            { value: 'immediate_rejected',  label: 'Immediate · cancel path' },
            { value: 'playbook_ioc_sweep',  label: 'Playbook · IOC sweep' },
            { value: 'verdict_triage',      label: 'Verdict card · triage verdict' }
        ];

    }
})();
