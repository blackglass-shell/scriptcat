import type { IGetSender } from "@Packages/message/server";
import PermissionVerify from "../permission_verify";
import type { GMApiRequest } from "../types";
import type GMApi from "./gm_api";
import type { ContinuationShimApiRequest } from "../continuation_shim";

class GMContinuationApi {
  @PermissionVerify.API({
    link: ["CAT.continuation"],
    dotAlias: false,
  })
  CAT_continuation(
    this: GMApi,
    request: GMApiRequest<[ContinuationShimApiRequest]>,
    sender: IGetSender
  ): Promise<unknown> {
    if (!this.continuationShimService) {
      throw new Error("ContinuationShimService is not available");
    }
    return this.continuationShimService.handleApi(request.script.uuid, request.params[0], sender);
  }
}

export default GMContinuationApi;
