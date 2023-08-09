export * from './useReadiness'
import { ClusterReadiness } from './clusterReadiness'

// IPC message listeners are set up by the constructor of ClusterReadiness.
// TODO(smitchell): The worker listener needs to know what callback(s) each worker needs to make to determine readiness, and listener setup only happens once.
//                  This is confusing to be associated with instantiation of an object, both because multiple instantiations won't change the listeners as implemented,
//                  and because both workers and primary need to instantiate it.
export const CLUSTER_READINESS = new ClusterReadiness();

