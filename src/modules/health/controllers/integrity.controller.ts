// HTTP controller of the money integrity routes (map domain G, /admin/system/integrity*, feature 12b). Thin: the rules live in IntegrityService.
import { Controller } from '@nestjs/common';
import { type ResultOf, Route } from '../../../common/contract';
import { CurrentStaff, type StaffPrincipal } from '../../identity';
import { IntegrityService } from '../application/integrity.service';
import { getIntegrity, runIntegrityCheck } from '../contracts/integrity.contracts';

/**
 * The integrity routes.
 *
 * Why: the console's Integrity tab shows the four ledger checks of the last run and reruns the check on demand.
 *
 * @route GET /admin/system/integrity
 * @route POST /admin/system/integrity/run
 */
@Controller()
export class IntegrityController {
  constructor(private readonly integrity: IntegrityService) {}

  /**
   * The integrity report.
   *
   * @returns the last run, the four checks and whether a run is going
   * @route GET /admin/system/integrity
   */
  @Route(getIntegrity)
  report(): Promise<ResultOf<typeof getIntegrity>> {
    return this.integrity.report();
  }

  /**
   * Runs the check now.
   *
   * @param staff the signed-in staff member
   * @returns the new run
   * @route POST /admin/system/integrity/run
   */
  @Route(runIntegrityCheck)
  run(@CurrentStaff() staff: StaffPrincipal): Promise<ResultOf<typeof runIntegrityCheck>> {
    return this.integrity.run(staff.staffId);
  }
}
